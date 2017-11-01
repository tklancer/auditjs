#!/bin/sh
':' //; exec "$(command -v node || command -v nodejs)" "$0" "$@"

/**
 *      Copyright (c) 2015-2017 Vör Security Inc.
 *      All rights reserved.
 *
 *      Redistribution and use in source and binary forms, with or without
 *      modification, are permitted provided that the following conditions are met:
 *          * Redistributions of source code must retain the above copyright
 *            notice, this list of conditions and the following disclaimer.
 *          * Redistributions in binary form must reproduce the above copyright
 *            notice, this list of conditions and the following disclaimer in the
 *            documentation and/or other materials provided with the distribution.
 *          * Neither the name of the <organization> nor the
 *            names of its contributors may be used to endorse or promote products
 *            derived from this software without specific prior written permission.
 *
 *      THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 *      ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *      WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 *      DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
 *      DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 *      (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 *      LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 *      ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 *      (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 *      SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/** Read through the package.json file in a specified directory. Build
 * a map of best case dependencies and indicate if there are any known
 * vulnerabilities.
 */
//create reports directory
var mkdirp = require('mkdirp');
var path = require('path');
//sumarize results in JUnit with this
var DOMParser = require('xmldom').DOMParser;
var XMLSerializer = require('xmldom').XMLSerializer;
//write found vulnerabilities to JUnit xml
var jsontoxml = require('jsontoxml');

// File system access
var fs = require('fs');

// Next two requires used to get version from out package.json file
var path = require('path');
var pkg = require( path.join(__dirname, 'package.json') );

// Actual auditing "library". The library uses the OSS Index REST API
// to retrieve dependency information.
var auditor = require('./audit-package');

// Adds colors to console output
var colors = require('colors/safe');

// Decode HTML entities
var Entities = require('html-entities').AllHtmlEntities;
var entities = new Entities();

// Semantic version code
var semver = require('semver');

// dictionary of vulnerable packages for xml-report
var JUnit = { 'testsuite':[] };

// Used to find installed packages and their dependencies
var npm = require('npm');

/**
 * Total number of dependencies being audited. This will be set
 * before starting the audit.
 */
var expectedAudits = 0;

/**
 * Total number of dependencies audited so far.
 */
var actualAudits = 0;

/**
 * List of dependencies that we want to check after the package checks.
 */
var dependencies = [];

/**
 * Map of dependencies to audit. This ensures we only audit a dependency
 * once.
 */
var auditLookup = {};

/**
 * Count encountered vulnerabilities
 */
var vulnerabilityCount = 0;

//Parse command line options. We currently support only one argument so
// this is a little overkill. It allows for future growth.
var program = require('commander');
program
        .version(pkg.version)
        .option('-b --bower', 'This flag is necessary to correctly audit bower\n\t\t\t\t packages. Use together with -p bower.json, since\n\t\t\t\t scanning bower_componfents is not supported')
        .option('-n --noNode', 'Ignore node executable when scanning node_modules.')
        .option('-p --package <file>', 'Specific package.json or bower.json file to audit')
        .option('-d --dependencyTypes <list>', 'One or more of devDependencies, dependencies, peerDependencies, bundledDependencies, or optionalDependencies')
        .option('-q --quiet', 'Supress console logging')
        .option('-r --report', 'Create JUnit reports in reports/ directory')
        .option('-v --verbose', 'Print all vulnerabilities')
        .option('-w --whitelist <file>', 'Whitelist of vulnerabilities that should not break the build,\n\t\t\t\t e.g. XSS vulnerabilities for an app with no possbile input for XSS.\b\t\t\t\t                                 See Example test_data/audit_package_whitelist.json.')
        .action(function () {
        });

program.on('--help', function(){
        usage();
});

program.parse(process.argv);
if(program['quiet']){
        console.log = function(){};
        process.stdout.write = function(){};
}
if(program['bower'] && !program['package']){
        throw Error('Use -b option together with -p bower.json. Bower dependencies are flat, therefore it is enough to only support the auditing of bower.json files.');
}
var programPackage = program['package'] ? path.basename(program['package']): 'scan_node_modules.json';
var output = `${programPackage.toString().split('.json').slice(0, -1)}.xml`;
var pm = program['bower'] ? 'bower' : 'npm'

var categories = ['dependencies'];
categories = program['dependencyTypes'] ? program['dependencyTypes'].split(",") : categories;

// Simplify the white-list so that it is a simple lookup table of vulnerability IDs.
var whitelist = program['whitelist'] ? fs.readFileSync(program['whitelist'], 'utf-8') : null;
whitelist = prepareWhitelist(whitelist);

// Remember all vulnerabilities that were white-listed
var whitelistedVulnerabilities = [];

// By default we run an audit against all installed packages and their
// dependencies.
if (!program["package"]) {
        npm.load(function(err, npm) {
                npm.commands.ls([], true, function(err, data, lite) {
                        // for (var key in data.dependencies) {
                        //     printDeps("", data.dependencies[key]);
                        // }

                        // Get a flat list of dependencies instead of a map.
                        var deps = getDependencyList("", data.dependencies);
                        if(program.noNode) {
                                // Set the number of expected audits
                                expectedAudits = deps.length;

                                // Only check dependencies
                                auditor.auditPackages(deps, resultCallback);
                        }
                        else {
                                // Set the number of expected audits
                                expectedAudits = deps.length + 1; // +1 for hardcoded nodejs test

                                // First check for node itself. We use the 'chocolatey' package manager
                                // to hang this query on.
                                auditor.auditPackage("chocolatey", "nodejs", process.version, function(err, data) {
                                        resultCallback(err, data);

                                        // Now check for the dependencies
                                        auditor.auditPackages(deps, resultCallback);
                                });
                        }
                });
        });
}

// If a package.json file is specified, do an audit on the dependencies
// in the file only.
else {

        //Load the target package file
        var filename = program["package"];
        var targetPkg = undefined;

        try {
                // default encoding is utf8
                encoding = 'utf8';

                // read file synchroneously
                var contents = fs.readFileSync(filename, encoding);

                // parse contents as JSON
                targetPkg = JSON.parse(contents);

        } catch (err) {
                // an error occurred
                throw err;
        }

        // Call the auditor library passing the dependency list from the
        // package.json file. The second argument is a callback that will
        // print the results to the console.
        var deps = [];
        for (var i = 0; i < categories.length; i++) {
        	var category = categories[i];
            if(targetPkg[category] != undefined) {
                // Get a flat list of dependencies instead of a map.
            	var myDeps = getDependencyList("", targetPkg[category]);
            	if (myDeps) {
            		// getDependencyList avoids duplicates, so we can just append
            		deps = deps.concat(myDeps);
            	}
            }
        }
        
        expectedAudits = deps.length;
        auditor.auditPackages(deps, resultCallback);
}

/** Set the return value
 *
 * @param options
 * @param err
 * @returns
 */
function exitHandler(options, err) {
	if (whitelistedVulnerabilities.length > 0) {
        console.log(colors.bold.yellow("Filtering the following vulnerabilities"));
        console.log(colors.bold.yellow('=================================================='));
        for (var i = 0; i < whitelistedVulnerabilities.length; i++) {
        	var detail = whitelistedVulnerabilities[i];
            console.log(`${colors.bold.blue(detail['title'])} affected versions: ${colors.red(detail['package'])} ${colors.red(detail['versions'])}`);
            console.log(`${detail['description']}`);
            console.log(colors.bold.yellow('=================================================='));
        };
	}
	
    if(program['report']) {
        var filtered = 0;
        mkdirp('reports');
        if (JUnit[0] != '<') { // This is a hack in case this gets called twice
        	// Convert to XML
            JUnit = jsontoxml(JUnit);
        }
        var dom = new DOMParser().parseFromString(JUnit);
        dom.documentElement.setAttribute('name', `auditjs.security.${programPackage.split('.')[0]}`);
        dom.documentElement.setAttribute('errors', 0);
        dom.documentElement.setAttribute('tests', expectedAudits);
        dom.documentElement.setAttribute('package', 'test');
        dom.documentElement.setAttribute('id', '');
        dom.documentElement.setAttribute('skipped', expectedAudits-actualAudits);
        dom.documentElement.setAttribute('failures', vulnerabilityCount-filtered);
        JUnit = new XMLSerializer().serializeToString(dom);
        console.log( `Wrote JUnit report to reports/${output}`);
        fs.writeFileSync('reports/' + output, `<?xml version="1.0" encoding="UTF-8"?>\n${JUnit}`);
        // Report mode is much like a test mode where builds shouldn't fail if the report was created.
        vulnerabilityCount = 0;
    }
    process.exit(vulnerabilityCount);
}

/**
 * Do some preparations on the whitelist, which results in it being a map of vulnerability
 * IDs (to themselves).
 */
function prepareWhitelist(whitelist) {
	if(whitelist){
        console.log(colors.bold('Applying whitelist filtering for JUnit reports. Take care to keep the whitelist up to date!'));

		// The white-list is either a list or the old format, which is an object with more
		// complex structures.
	    whitelist = JSON.parse(whitelist);
	    
	    // If we are using the old white list format, then convert it to the simplified format
	    if (!Array.isArray(whitelist)) {
            console.log('TKOLD WHITELIST');
	    	whitelist = simplifyWhitelist(whitelist);
	    }
	    
	    // Convert the list to a map for easy lookup
	    var whitelistMap = {};
	    for (var i = 0; i < whitelist.length; i++) {
	    	var key = whitelist[i];
            if (typeof key.id !== 'undefined'){
                whitelistMap[key.id] = key;
            }
            else {
                whitelistMap[key] = key;
            }
	    }
	    whitelist = whitelistMap;
	}
	return whitelist;
}

/**
 * Simplify the white-list into a list of issue IDs.
 */
function simplifyWhitelist(whitelist) {
	var results = [];
	for (var project in whitelist) {
		var vlist = whitelist[project];
		for (var i = 0; i < vlist.length; i++) {
			var id = vlist[i].id;
            var path = vlist[i].path;
			results.push({id, path});
		}
	}
	return results;
}

function replacer(key, value) {
        if(typeof value === 'undefined'){
                return undefined;
        }
        return value;
}

//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit:true}));

// Check if all properties of an object are null and return true if they are
function checkProperties(obj) {
        for (var key in obj) {
                if (obj[key] !== null && obj[key] != "")
                        return false;
        }
        return true;
}

/** Recursively get a flat list of dependency objects. This is simpler for
 * subsequent code to handle then a tree of dependencies.
 *
 * @param depMap
 * @returns A list of dependency objects
 */
function getDependencyList(rootPath, depMap) {
    console.log('TKstarting with', rootPath);
        var results = [];
        var lookup = {};
        var keys = Object.keys(depMap);
        for(var i = 0; i < keys.length; i++) {
                var name = keys[i];
                var currentPath = rootPath === '' ? name : rootPath + '/' + name

                // The value of o depends on the type of structure we are passed
                var o = depMap[name];
                if(o.version) {
                        // Only add a dependency once
                        if(lookup[name + o.version] == undefined) {
                                lookup[name + o.version] = true;
                                // We need both the local and global "auditLookup" tables.
                                // The global lookup is used to ensure we only audit a
                                // dependency once, but cannot be done at the same level
                                // as the local lookup since the sub-dependencies are not
                                // available at all locations of the dependency tree (depMap).
                                if (auditLookup[name + o.version] == undefined) {
									auditLookup[name + o.version] = true;
									results.push({"pm": pm, "name": name, "version": o.version, "path": currentPath});
								}
                                if(o.dependencies) {
                                        var deps = getDependencyList(currentPath, o.dependencies);

                                        if(deps != undefined) {
                                                results = results.concat(deps);
                                        }
                                }
                        }
                }
                else {
                        // Only add a dependency once
                        if(lookup[name + o] == undefined) {
                                lookup[name + o] = true;
                                if (auditLookup[name + o] == undefined) {
									auditLookup[name + o] = true;
									results.push({"pm": pm, "name": name, "version": o, "path": currentPath});
								}
                        }
                }
        }
        return results;
}

/** Help text
 *
 * @returns
 */
function usage() {
        console.log("Audit installed packages and their dependencies to identify known");
        console.log("vulnerabilities.");
        console.log();
        console.log("If a package.json file is specified as an argument, only the dependencies in");
        console.log("the package file will be audited.");
        console.log();
        console.log(colors.bold.yellow("Limitations"));
        console.log();
        console.log("As this program depends on the OSS Index database, network access is");
        console.log("required. Connection problems with OSS Index will result in an exception.");
        console.log();
        console.log("The vulnerabilities do not always indicate all (or any) of the affected");
        console.log("versions it is best to read the vulnerability text itself to determine");
        console.log("whether any particular version is known to be vulnerable.");
}

/** Write the audit results. This handles both standard and verbose
 * mode.
 *
 * Currently the v2 API does not provide information about most recently available
 * package version, so some of this code can be considered "dead" until that
 * information becomes available.
 *
 * @param pkgName
 * @param version
 * @param details
 * @returns
 */
function resultCallback(err, pkg) {
    console.log('TKgot callback', pkg.name);
        pkgName = undefined;
        version = undefined;
        versionString = undefined;
        bestVersion = undefined;
        if(pkg) {
                pkgName = pkg.name;
                version = pkg.version;
                versionString = version;
                bestVersion = undefined;
        }
        // Add one to audits completed
        actualAudits++;

        // If we KNOW a possibly used version is vulnerable then highlight the
        // title in red.
        var myVulnerabilities = getValidVulnerabilities(version, pkg.vulnerabilities, pkg.name, pkg.path);
        if(myVulnerabilities.length > 0) {
                vulnerabilityCount += 1;
                console.log("------------------------------------------------------------");
                console.log("[" + actualAudits + "/" + expectedAudits + "] " + colors.bold.red(pkgName + " " + versionString + "  [VULNERABLE]") + "   ");
                JUnit['testsuite'].push({name: 'testcase', attrs: {name: pkg.name}, children: [{
                        name: 'failure', text: `Details:\n
                        ${JSON.stringify(myVulnerabilities, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}\n\n`,
                        attrs: {message:`Found ${myVulnerabilities.length} vulnerabilities. See stacktrace for details.`}}]});
        }
        else {
                if(program.verbose) console.log("------------------------------------------------------------");
                process.stdout.write("[" + actualAudits + "/" + expectedAudits + "] " + colors.bold(pkgName + " " + versionString) + "   ");
                if(program.verbose) console.log();
                JUnit['testsuite'].push({name: 'testcase', attrs: {name: pkg.name}});
        }

        if(err) {
                if(err.error) {
                        console.log(colors.bold.red("Error running audit: " + err.error + " (" + err.code + ")"));
                }
                else {
                        console.log(colors.bold.red("Error running audit: " + err));
                }
                if(err.stack) {
                        console.log(err.stack);
                }
                return;
        }

        // Print information about the expected and actual package versions
        if(program.verbose) {
                if(semver.valid(version)) {
                        if(bestVersion) {
                                if(bestVersion != version) {
                                        console.log(colors.bold.yellow("Installed version: " + version));
                                }
                                else {
                                        console.log("Installed version: " + version);
                                }
                                console.log("Available version: " + bestVersion);
                        }
                        else {
                                console.log("Installed version: " + version);
                        }
                }
                else {
                        console.log("Requested range: " + version);
                        if(bestVersion) {
                                console.log("Available version: " + bestVersion);
                        }
                }
        }

        // The details will specify whether there are vulnerabilities and what the
        // vulnerability status is.
        if(pkg.vulnerabilities != undefined) {
                // Special statuses
                if(pkg.vulnerabilities.length == 0) {
                        // FIXME: We should always get some response. This should not happen.
                        console.log(colors.grey("No known vulnerabilities..."));
                }
                // Vulnerabilities found
                else {
                        // Status line
                        console.log(pkg.vulnerabilities.length + " known vulnerabilities, " + myVulnerabilities.length + " affecting installed version");

                        // By default only print known problems
                        var printTheseProblems = myVulnerabilities;

                        // If verbose, print all problems
                        if(program.verbose) {
                                printTheseProblems = pkg.vulnerabilities;
                        }

                        // We have decided that these are the problems worth mentioning.
                        for(var i = 0; i < printTheseProblems.length; i++) {
                                console.log();

                                var detail = printTheseProblems[i];
                                console.log(colors.red.bold(detail.title));

                                if(detail.description != undefined) {
                                        console.log(entities.decode(detail.description));
                                }
                                console.log();

                                // Print affected version information if available
                                if(detail.versions != null && detail.versions.length > 0) {
                                        var vers = detail.versions.join(",");
                                        if(vers.trim() == "") {
                                                vers = "unspecified";
                                        }
                                        console.log(colors.bold("Affected versions") + ": " + vers);
                                }
                                else {
                                        console.log(colors.bold("Affected versions") + ": unspecified");
                                }

                                if (detail.references != undefined && detail.references.length > 0) {
                                        console.log(colors.bold("References") + ":");
                                        for (var j = 0; j < detail.references.length; j++) {
                                                console.log("  * " + detail.references[j]);
                                        }
                                }
                        }

                        // If we printed vulnerabilities we need a separator. Don't bother
                        // if we are running in verbose mode since one will be printed later.
                        if(!program.verbose && myVulnerabilities.length > 0) {
                                console.log("------------------------------------------------------------");
                                console.log();
                        }
                }
        } else {
                console.log(colors.grey("No known vulnerabilities..."));
        }

        if(program.verbose) {
                // Print a separator
                console.log("------------------------------------------------------------");
                console.log();
        }

        //console.log(JSON.stringify(pkg.artifact));
}

/** Return list of vulnerabilities found to affect this version.
 *
 * The input 'version' or details 'versions' may be ranges, depending
 * on the situation.
 *
 * @param productRange A version range as defined by semantic versioning
 * @param details Vulnerability details
 * @returns
 */
function getValidVulnerabilities(productRange, details, pkg, path) {
        var results = [];
        if(details != undefined) {
                for(var i = 0; i < details.length; i++) {
                        var detail = details[i];
                        
                        if(detail.versions != undefined && detail.versions.length > 0) {
                                for(var j = 0; j < detail.versions.length; j++) {
                                        // Get the vulnerability range
                                        var vulnRange = detail.versions[j]

                                        if(rangesOverlap(productRange, vulnRange)) {
                                        		// Do we white-list this match?
	                                            var id = detail.id;
                                                console.log('TKCHECKING WHITELIST FOR ID: ', id);
	                                            if (whitelist && whitelist[id]) {
                                                    if (typeof whitelist[id] === 'object') {
                                                        //Check path
                                                        var pathRegex = whitelist[id].path;
                                                        console.log('TKpath: ', path)
                                                        console.log('TKregex ', pathRegex);
                                                        if (path.match(pathRegex).index === 0) {
                                                            console.log('TKSKIPPING');
                                                            detail["package"] = pkg;
                                                            detail["path"] = path;
                                                            whitelistedVulnerabilities.push(detail);
                                                            break;
                                                        }
                                                    }
                                                    else {
    	                                            	detail["package"] = pkg;
    	                                            	whitelistedVulnerabilities.push(detail);
    	                                            	break;
                                                    }
	                                            }

                                                results.push(detail);
                                                break;
                                        }
                                }
                        }
                }
        }
        return results;
}

/** Return true if the given ranges overlap.
 *
 * @param prange Product range
 * @param vrange Vulnerability range
 */
function rangesOverlap(prange, vrange) {
        // Try and treat the vulnerability range as a single version, as it
        // is in CVEs.
        if(semver.valid(getSemanticVersion(vrange))) {
                return semver.satisfies(getSemanticVersion(vrange), prange);
        }

        // Try and treat the product range as a single version, as when not
        // run in --package mode.
        if(semver.valid(getSemanticVersion(prange))) {
                return semver.satisfies(getSemanticVersion(prange), vrange);
        }

        // Both prange and vrange are ranges. A simple test for overlap for not
        // is to attempt to coerce a range into static versions and compare
        // with the other ranges.
        var pversion = forceSemanticVersion(prange);
        if(pversion != undefined) {
                if(semver.satisfies(pversion, vrange)) return true;
        }

        var vversion = forceSemanticVersion(vrange);
        if(vversion != undefined) {
                if(semver.satisfies(vversion, prange)) return true;
        }

        return false;
}

/** Try and force a version to match that expected by semantic versioning.
 *
 * @param version
 * @returns
 */
function getSemanticVersion(version) {
        // Correct semantic version: x.y.z
        if(version.match("^[0-9]+\.[0-9]+\.[0-9]+$")) return version;

        // x.y
        if(version.match("^[0-9]+\.[0-9]+$")) return version + ".0";

        // Fall back: hope it works
        return version;
}

/** Identify a semantic version within the given range for use in comparisons.
 *
 * @param range
 * @returns
 */
function forceSemanticVersion(range) {
        var re = /([0-9]+)\.([0-9]+)\.([0-9]+)/;
        var match = range.match(re);
        if(match != undefined) {
                return match[1] + "." + match[2] + "." + match[3];
        }
        return undefined;
}
