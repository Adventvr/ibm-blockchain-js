'use strict';
/* global __dirname */
/*******************************************************************************
 * Copyright (c) 2016 IBM Corp.
 *
 * All rights reserved.
 *
 *******************************************************************************/
/*
	Updated: 03/15/2016
*/

//Load modules
var fs = require('fs');
var path = require('path');
var https = require('https');
var async = require('async');
var rest = require(__dirname + '/lib/rest');
var AdmZip = require('adm-zip');


function ibc() {}
ibc.chaincode = {																	//init it all
	read: null,
	query: null,
	write: null,
	remove: null,
	deploy: null,
	details:{
		deployed_name: '',
		func: [],
		git_url: '',
		peers: [],
		timestamp: 0,
		users: [],
		unzip_dir: '',
		zip_url: ''
	}
};
ibc.selectedPeer = 0;
ibc.q = [];																			//array of unix timestamps, 1 for each unsettled action
ibc.lastPoll = 0;																	//unix timestamp of the last time we polled
ibc.lastBlock = 0;																	//last blockheight found
var tempDirectory = path.join(__dirname, './temp');									//	=./temp - temp directory name


// ============================================================================================================================
// EXTERNAL - load() - wrapper on a standard startup flow.
// 1. load network peer data
// 2. register users with security (if present)
// 3. load chaincode and parse
// ============================================================================================================================
ibc.prototype.load = function(options, cb){
	var errors = [];
	if(!options.network || !options.network.peers) errors.push('the option "network.peers" is required');

	if(!options.chaincode || !options.chaincode.zip_url) errors.push('the option "chaincode.zip_url" is required');
	if(!options.chaincode || !options.chaincode.unzip_dir) errors.push('the option "chaincode.unzip_dir" is required');
	if(!options.chaincode || !options.chaincode.git_url) errors.push('the option "chaincode.git_url" is required');
	if(errors.length > 0){															//check for input errors
		console.log('! [ibc-js] Input Error - ibc.load()', errors);
		if(cb) cb(eFmt('load() input error', 400, errors));
		return;																		//get out of dodge
	}

	ibc.chaincode = {																//empty it all
					read: null,
					query: null,
					write: null,
					remove: null,
					deploy: null,
					details:{
								deployed_name: '',
								func: [],
								git_url: '',
								peers: [],
								timestamp: 0,
								users: [],
								unzip_dir: '',
								zip_url: ''
					}
				};

	// Step 1
	ibc.prototype.network(options.network.peers, options.network.options);

	// Step 2 - optional - only for secure networks
	if(options.network.users){
		options.network.users = filter_users(options.network.users);				//only use the appropriate IDs filter out the rest
	}
	if(options.network.users && options.network.users.length > 0){
		ibc.chaincode.details.users = options.network.users;
		var arr = [];
		for(var i in ibc.chaincode.details.peers){
			arr.push(i);															//build the list of indexes
		}
		async.each(arr, function(i, a_cb) {
			if(options.network.users[i]){											//make sure we still have a user for this network
				ibc.prototype.register(i, options.network.users[i].username, options.network.users[i].secret, a_cb);
			}
			else a_cb();
		}, function(err, data){
			if(err && cb) return cb(err);													//error already formated
			else load_cc();
		});
	}
	else{
		ibc.chaincode.details.users = [];
		console.log('[ibc-js] No membership users found after filtering, assuming this is a network w/o membership');
		load_cc();
	}

	// Step 3
	function load_cc(){
		ibc.prototype.load_chaincode(options.chaincode, cb);						//download/parse and load chaincode
	}
};

// ============================================================================================================================
// EXTERNAL - load_chaincode() - load the chaincode and parssssssssse
// 0. Load the github or zip
// 1. Unzip & scan directory for files
// 2. Iter over go files
// 		2a. Find the boundaries for the Run() in the cc
//		2b. Grab function names that need to be exported
//		2c. Create JS function for golang function
// 3. Call callback()
// ============================================================================================================================
ibc.prototype.load_chaincode = function(options, cb) {
	var errors = [];
	if(!options.zip_url) errors.push('the option "zip_url" is required');
	if(!options.unzip_dir) errors.push('the option "unzip_dir" is required');
	if(!options.git_url) errors.push('the option "git_url" is required');
	if(errors.length > 0){															//check for input errors
		console.log('! [ibc-js] Input Error - ibc.load_chaincode()', errors);
		if(cb) cb(eFmt('load_chaincode() input error', 400, errors));
		return;																		//get out of dodge
	}

	var keep_looking = true;
	var zip_dest = path.join(tempDirectory,  '/file.zip');							//	=./temp/file.zip
	var unzip_dest = path.join(tempDirectory,  '/unzip');							//	=./temp/unzip
	var unzip_cc_dest = path.join(unzip_dest, '/', options.unzip_dir);				//	=./temp/unzip/DIRECTORY
	ibc.chaincode.details.zip_url = options.zip_url;
	ibc.chaincode.details.unzip_dir = options.unzip_dir;
	ibc.chaincode.details.git_url = options.git_url;
	ibc.chaincode.details.deployed_name = options.deployed_name;

	if(!options.deployed_name || options.deployed_name === ''){						//lets clear and re-download
		ibc.prototype.clear(cb_ready);
	}
	else{
		cb_ready();
	}

	// check if we already have the chaincode in the local filesystem, else download it
	function cb_ready(){
		try{fs.mkdirSync(tempDirectory);}
		catch(e){ }
		fs.access(unzip_cc_dest, cb_file_exists);									//check if files exist yet
		function cb_file_exists(e){
			if(e != null){
				download_it(options.zip_url);										//nope, go download it
			}
			else{
				console.log('[ibc-js] Found chaincode in local file system');
				fs.readdir(unzip_cc_dest, cb_got_names);							//yeppers, go use it
			}
		}
	}

	// Step 0.
	function download_it(download_url){
		console.log('[ibc-js] Downloading zip');
		var file = fs.createWriteStream(zip_dest);
		https.get(download_url, function(response) {
			response.pipe(file);
			file.on('finish', function() {
				if(response.headers.status === '302 Found'){
					console.log('redirect...', response.headers.location);
					file.close();
					download_it(response.headers.location);
				}
				else{
					file.close(cb_downloaded);  									//close() is async
				}
			});
		}).on('error', function(err) {
			console.log('! [ibc-js] Download error');
			fs.unlink(zip_dest); 													//delete the file async
			if (cb) cb(eFmt('doad_chaincode() download error', 500, err.message), ibc.chaincode);
		});
	}

	// Step 1.
	function cb_downloaded(){
		console.log('[ibc-js] Unzipping zip');
		var zip = new AdmZip(zip_dest);
		zip.extractAllTo(unzip_dest, /*overwrite*/true);
		console.log('[ibc-js] Unzip done');
		fs.readdir(unzip_cc_dest, cb_got_names);
		fs.unlink(zip_dest, function(err) {});										//remove zip file, never used again
	}

	// Step 2.
	function cb_got_names(err, obj){
		console.log('[ibc-js] Scanning files', obj);
		var foundGo = false;
		if(err != null) console.log('! [ibc-js] fs readdir Error', err);
		else{
			for(var i in obj){
				if(obj[i].indexOf('.go') >= 0){										//look for GoLang files
					if(keep_looking){
						foundGo = true;
						var file = fs.readFileSync(path.join(unzip_cc_dest, obj[i]), 'utf8');
						parse_go_file(obj[i], file);
					}
				}
			}
		}
		if(!foundGo){																//error
			var msg = 'did not find any *.go files, cannot continue';
			console.log('! [ibc-js] Error - ', msg);
			if(cb) cb(eFmt('load_chaincode() no chaincode', 400, msg), null);
		}
	}

	function parse_go_file(name, str){
		var msg = '';
		if(str == null) console.log('! [ibc-js] fs readfile Error');
		else{
			console.log('[ibc-js] Parsing file', name);
			
			// Step 2a.
			var go_func_regex = /func\s+\(\w+\s+\*SimpleChaincode\)\s+(\w+)/g;		//find chaincode's go lang functions
			var result, go_funcs = [];
			while ( (result = go_func_regex.exec(str)) ) {
				go_funcs.push({name: result[1], pos: result.index});
			}
			
			var start = 0;
			var stop = 0;
			for(var i in go_funcs){
				if(go_funcs[i].name.toLowerCase() === 'run'){
					start = go_funcs[i].pos;										//find start and stop positions around the "Run()" function
					if(go_funcs[Number(i) + 1] == null) stop = start * 2;			//run is the last function.. so uhhhh just make up a high number
					else stop = go_funcs[Number(i) + 1].pos;
					break;
				}
			}
			
			if(start === 0 && stop === 0){
				msg = 'did not find Run() function in chaincode, cannot continue';
				console.log('! [ibc-js] Error -', msg);
				if(cb) return cb(eFmt('load_chaincode() missing Run()', 400, msg), null);
			}
			else{
				
				// Step 2b.
				var regex = /function\s+==\s+"(\w+)"/g;									//find the exposed chaincode functions in "Run()""
				var cc_funcs = [];
				var result2;
				while ( (result2 = regex.exec(str)) ) {
					if(result2.index > start && result2.index < stop){					//make sure its inside Run()
						cc_funcs.push(result2[1]);
					}
				}
			
				if(cc_funcs.length === 0){
					msg = 'did not find GoLang functions exposed in chaincode\s Run() function';
					console.log('[ibc-js] Error - ', msg);
					if(cb) return cb(eFmt('load_chaincode() no go functions', 400, msg), null);
				}
				else{
					keep_looking = false;
				
					// Step 2c.
					ibc.chaincode.details.func = [];
					for(i in cc_funcs){													//build the rest call for each function
						build_invoke_func(cc_funcs[i]);
					}

					// Step 3.
					ibc.chaincode.details.timestamp = Date.now();
					ibc.chaincode.read = read;
					ibc.chaincode.query = query;
					ibc.chaincode.write = write;
					ibc.chaincode.remove = remove;
					ibc.chaincode.deploy = deploy;
					if(cb) return cb(null, ibc.chaincode);								//all done, send it to callback
				}
			}
		}
	}
};

// ============================================================================================================================
// EXTERNAL - network() - setup network configuration to hit a rest peer
// ============================================================================================================================
ibc.prototype.network = function(arrayPeers, options){
	var errors = [];
	var quiet = true;
	var timeout = 60000;
	if(!arrayPeers) errors.push('network input arg should be array of peer objects');
	else if(arrayPeers.constructor !== Array) errors.push('network input arg should be array of peer objects');
	
	if(options){
		if(options.quiet === true || options.quiet === false) quiet = options.quiet;	//optional fields
		if(Number(options.timeout)) timeout = options.timeout;
	}
	
	for(var i in arrayPeers){															//check for errors in peers
		if(!arrayPeers[i].id) 		errors.push('peer ' + i + ' is missing the field id');
		if(!arrayPeers[i].api_host) errors.push('peer ' + i + ' is missing the field api_host');
		if(!arrayPeers[i].api_port) errors.push('peer ' + i + ' is missing the field api_port');
		if(!arrayPeers[i].api_url)  errors.push('peer ' + i + ' is missing the field api_url');
	}

	if(errors.length > 0){																//check for input errors
		console.log('! [ibc-js] Input Error - ibc.network()', errors);
	}
	else{
		ibc.chaincode.details.peers = [];
		for(i in arrayPeers){
			var pos = arrayPeers[i].id.indexOf('_') + 1;
			var temp = 	{
							name: '',
							api_host: arrayPeers[i].api_host,
							api_port: arrayPeers[i].api_port,
							id: arrayPeers[i].id,
							ssl: true
						};
			temp.name = arrayPeers[i].id.substring(pos) + '-' + arrayPeers[i].api_host + ':' + arrayPeers[i].api_port;	//build friendly name
			if(arrayPeers[i].api_url.indexOf('https') == -1) temp.ssl = false;
			console.log('[ibc-js] Peer: ', temp.name);
			ibc.chaincode.details.peers.push(temp);
		}

		rest.init({																		//load default values for rest call to peer
					host: ibc.chaincode.details.peers[0].api_host,
					port: ibc.chaincode.details.peers[0].api_port,
					headers: {
								'Content-Type': 'application/json',
								'Accept': 'application/json',
							},
					ssl: ibc.chaincode.details.peers[0].ssl,
					timeout: timeout,
					quiet: quiet
		});
	}
};


// ============================================================================================================================
// EXTERNAL - switchPeer() - switch the default peer to hit
// ============================================================================================================================
ibc.prototype.switchPeer = function(index) {
	if(ibc.chaincode.details.peers[index]) {
		rest.init({																	//load default values for rest call to peer
					host: ibc.chaincode.details.peers[index].api_host,
					port: ibc.chaincode.details.peers[index].api_port,
					headers: {
								'Content-Type': 'application/json',
								'Accept': 'application/json',
							},
					ssl: ibc.chaincode.details.peers[index].ssl,
					timeout: 60000,
					quiet: true
		});
		ibc.selectedPeer = index;
		return true;
	} else {
		return false;
	}
};

// ============================================================================================================================
// EXTERNAL - save() - write chaincode details to a json file
// ============================================================================================================================
ibc.prototype.save =  function(dir, cb){
	var errors = [];
	if(!dir) errors.push('the option "dir" is required');
	if(errors.length > 0){																//check for input errors
		console.log('[ibc-js] Input Error - ibc.save()', errors);
		if(cb) cb(eFmt('save() input error', 400, errors));
	}
	else{
		var fn = 'chaincode.json';														//default name
		if(ibc.chaincode.details.deployed_name) fn = ibc.chaincode.details.deployed_name + '.json';
		var dest = path.join(dir, fn);
		fs.writeFile(dest, JSON.stringify({details: ibc.chaincode.details}), function(e){
			if(e != null){
				console.log('[ibc-js] ibc.save() error', e);
				if(cb) cb(eFmt('save() fs write error', 500, e), null);
			}
			else {
				//console.log(' - saved ', dest);
				if(cb) cb(null, null);
			}
		});
	}
};

// ============================================================================================================================
// EXTERNAL - clear() - clear the temp directory
// ============================================================================================================================
ibc.prototype.clear =  function(cb){
	console.log('[ibc-js] removing temp dir');
	removeThing(tempDirectory, cb);											//remove everything in this directory
};

function removeThing(dir, cb){
	//console.log('!', dir);
	fs.readdir(dir, function (err, files) {
		if(err != null || !files || files.length === 0){
			cb();
		}
		else{
			async.each(files, function (file, cb) {							//over each thing
				file = path.join(dir, file);
				fs.stat(file, function(err, stat) {
					if (err) {
						if(cb) cb(err);
						return;
					}
					if (stat.isDirectory()) {
						removeThing(file, cb);								//keep going
					}
					else {
						//console.log('!', dir);
						fs.unlink(file, function(err) {
							if (err) {
								//console.log('error', err);
								if(cb) cb(err);
								return;
							}
							//console.log('good', dir);
							if(cb) cb();
							return;
						});
					}
				});
			}, function (err) {
				if(err){
					if(cb) cb(err);
					return;
				}
				fs.rmdir(dir, function (err) {
					if(cb) cb(err);
					return;
				});
			});
		}
	});
}

//============================================================================================================================
// EXTERNAL chain_stats() - get blockchain stats
//============================================================================================================================
ibc.prototype.chain_stats =  function(cb){
	var options = {path: '/chain'};									//very simple API, get chainstats!

	options.success = function(statusCode, data){
		console.log('[ibc-js] Chain Stats - success');
		if(cb) cb(null, data);
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Chain Stats - failure:', statusCode, e);
		if(cb) cb(eFmt('chain_stats() error', statusCode, e), null);
	};
	rest.get(options, '');
};

//============================================================================================================================
// EXTERNAL block_stats() - get block meta data
//============================================================================================================================
ibc.prototype.block_stats =  function(id, cb){
	var options = {path: '/chain/blocks/' + id};					//i think block IDs start at 0, height starts at 1, fyi
	options.success = function(statusCode, data){
		console.log('[ibc-js] Block Stats - success');
		if(cb) cb(null, data);
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Block Stats - failure:', statusCode);
		if(cb) cb(eFmt('block_stats() error', statusCode, e), null);
	};
	rest.get(options, '');
};


//============================================================================================================================
//read() - read generic variable from chaincode state
//============================================================================================================================
function read(name, username, cb){
	if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
		cb = username;
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}
	if(username == null) {													//if username not provided, use known valid one
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}

	var options = {
		path: '/devops/query'
	};
	var body = {
					chaincodeSpec: {
						type: 'GOLANG',
						chaincodeID: {
							name: ibc.chaincode.details.deployed_name,
						},
						ctorMsg: {
							function: 'query',
							args: [name]
						},
						secureContext: username
					}
				};
	//console.log('body', body);
	options.success = function(statusCode, data){
		console.log('[ibc-js] Read - success:', data);
		if(cb) cb(null, data.OK);
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Read - failure:', statusCode);
		if(cb) cb(eFmt('read() error', statusCode, e), null);
	};
	rest.post(options, '', body);
}

//============================================================================================================================
//query() - read generic variable from chaincode state
//============================================================================================================================
function query(args, username, cb){
	if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
		cb = username;
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}
	if(username == null) {													//if username not provided, use known valid one
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}

	var options = {
		path: '/devops/query'
	};
	var body = {
					chaincodeSpec: {
						type: 'GOLANG',
						chaincodeID: {
							name: ibc.chaincode.details.deployed_name,
						},
						ctorMsg: {
							function: 'query',
							args: args
						},
						secureContext: username
					}
				};
	//console.log('body', body);
	options.success = function(statusCode, data){
		console.log('[ibc-js] Query - success:', data);
		if(cb) cb(null, data.OK);
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Query - failure:', statusCode);
		if(cb) cb(eFmt('query() error', statusCode, e), null);
	};
	rest.post(options, '', body);
}

//============================================================================================================================
//write() - write generic variable to chaincode state
//============================================================================================================================
function write(name, val, username, cb){
	if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
		cb = username;
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}
	if(username == null) {													//if username not provided, use known valid one
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}

	var options = {
		path: '/devops/invoke'
	};
	var body = {
					chaincodeSpec: {
						type: 'GOLANG',
						chaincodeID: {
							name: ibc.chaincode.details.deployed_name,
						},
						ctorMsg: {
							function: 'write',
							args: [name, val]
						},
						secureContext: username
					}
				};

	options.success = function(statusCode, data){
		console.log('[ibc-js] Write - success:', data);
		ibc.q.push(Date.now());																//new action, add it to queue
		if(cb) cb(null, data);
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Write - failure:', statusCode);
		if(cb) cb(eFmt('write() error', statusCode, e), null);
	};
	rest.post(options, '', body);
}

//============================================================================================================================
//remove() - delete a generic variable from chaincode state
//============================================================================================================================
function remove(name, username, cb){
	if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
		cb = username;
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}
	if(username == null) {													//if username not provided, use known valid one
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}

	var options = {
		path: '/devops/invoke'
	};
	var body = {
					chaincodeSpec: {
						type: 'GOLANG',
						chaincodeID: {
							name: ibc.chaincode.details.deployed_name,
						},
						ctorMsg: {
							function: 'delete',
							args: [name]
						},
						secureContext: username
					}
				};

	options.success = function(statusCode, data){
		console.log('[ibc-js] Remove - success:', data);
		ibc.q.push(Date.now());																//new action, add it to queue
		if(cb) cb(null, data);
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Remove - failure:', statusCode);
		if(cb) cb(eFmt('remove() error', statusCode, e), null);
	};
	rest.post(options, '', body);
}

//============================================================================================================================
// EXTERNAL - register() - register a username with a peer (only for a secured blockchain network)
//============================================================================================================================
ibc.prototype.register = function(index, enrollID, enrollSecret, cb) {
	console.log('[ibc-js] Registering ', ibc.chaincode.details.peers[index].name, ' w/enrollID - ' + enrollID);
	var options = {
		path: '/registrar',
		host: ibc.chaincode.details.peers[index].api_host,
		port: ibc.chaincode.details.peers[index].api_port,
		ssl: ibc.chaincode.details.peers[index].ssl
	};

	var body = 	{
					enrollId: enrollID,
					enrollSecret: enrollSecret
				};

	options.success = function(statusCode, data){
		console.log('[ibc-js] Registration success:', enrollID);
		ibc.chaincode.details.peers[index].user = enrollID;								//remember a valid user for this peer
		if(cb){
			cb(null, data);
		}
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] Register - failure:', enrollID, statusCode);
		if(cb) cb(eFmt('register() error', statusCode, e), null);
	};
	rest.post(options, '', body);
};

//============================================================================================================================
//deploy() - deploy chaincode and call a cc function
//============================================================================================================================
function deploy(func, args, save_path, username, cb){
	if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
		cb = username;
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}
	if(username == null) {													//if username not provided, use known valid one
		username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
	}

	console.log('[ibc-js] Deploying Chaincode - Starting');
	console.log('[ibc-js] \tfunction:', func, ', arg:', args);
	console.log('\n\n\t Waiting...');											//this can take awhile
	var options = {path: '/devops/deploy'};
	var body = 	{
					type: 'GOLANG',
					chaincodeID: {
							path: ibc.chaincode.details.git_url
						},
					ctorMsg:{
							'function': func,
							'args': args
					},
					secureContext: username
				};
	//console.log('!body', body);
	options.success = function(statusCode, data){
		console.log('\n\n\t deploy success [wait 1 more minute]');
		ibc.chaincode.details.deployed_name = data.message;
		ibc.prototype.save(tempDirectory);										//save it so we remember we have deployed
		if(save_path != null) ibc.prototype.save(save_path);					//user wants the updated file somewhere
		if(cb){
			setTimeout(function(){
				console.log('[ibc-js] Deploying Chaincode - Complete');
				cb(null, data);
			}, 40000);															//wait extra long, not always ready yet
		}
	};
	options.failure = function(statusCode, e){
		console.log('[ibc-js] deploy - failure:', statusCode);
		if(cb) cb(eFmt('deploy() error', statusCode, e), null);
	};
	rest.post(options, '', body);
}

//============================================================================================================================
//heart_beat() - interval function to poll against blockchain height (has fast and slow mode)
//============================================================================================================================
var slow_mode = 10000;
var fast_mode = 500;
function heart_beat(){
	if(ibc.lastPoll + slow_mode < Date.now()){									//slow mode poll
		//console.log('[ibc-js] Its been awhile, time to poll');
		ibc.lastPoll = Date.now();
		ibc.prototype.chain_stats(cb_got_stats);
	}
	else{
		for(var i in ibc.q){
			var elasped = Date.now() - ibc.q[i];
			if(elasped <= 3000){												//fresh unresolved action, fast mode!
				console.log('[ibc-js] Unresolved action, must poll');
				ibc.lastPoll = Date.now();
				ibc.prototype.chain_stats(cb_got_stats);
			}
			else{
				//console.log('[ibc-js] Expired, removing');
				ibc.q.pop();													//expired action, remove it
			}
		}
	}
}

function cb_got_stats(e, stats){
	if(e == null){
		if(stats && stats.height){
			if(ibc.lastBlock != stats.height) {									//this is a new block!
				console.log('[ibc-js] New block!', stats.height);
				ibc.lastBlock  = stats.height;
				ibc.q.pop();													//action is resolved, remove
				if(ibc.monitorFunction) ibc.monitorFunction(stats);				//call the user's callback
			}
		}
	}
}

//============================================================================================================================
// EXTERNAL- monitor_blockheight() - exposed function that user can use to get callback when any new block is written to the chain
//============================================================================================================================
ibc.prototype.monitor_blockheight = function(cb) {								//hook in your own function, triggers when chain grows
	setInterval(function(){heart_beat();}, fast_mode);
	ibc.monitorFunction = cb;													//store it
};



//============================================================================================================================
//													Helper Functions() 
//============================================================================================================================
//build_invoke_func() - create JS function that calls the custom goLang function in the chaincode
//==================================================================
function build_invoke_func(name){
	if(ibc.chaincode[name] != null){												//skip if already exists
		//console.log('[ibc-js] \t skip, func', name, 'already exists');
	}
	else {
		console.log('[ibc-js] Found cc invoke function: ', name);
		ibc.chaincode.details.func.push(name);
		ibc.chaincode[name] = function(args, username, cb){							//create the function in the chaincode obj
			if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
				cb = username;
				username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
			}
			if(username == null) {													//if username not provided, use known valid one
				username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
			}

			var options = {path: '/devops/invoke'};
			var body = {
					chaincodeSpec: {
						type: 'GOLANG',
						chaincodeID: {
							name: ibc.chaincode.details.deployed_name,
						},
						ctorMsg: {
							function: name,
							args: args
						},
						secureContext: username
					}
			};

			options.success = function(statusCode, data){
				console.log('[ibc-js]', name, ' - success:', data);
				ibc.q.push(Date.now());												//new action, add it to queue
				if(cb) cb(null, data);
			};
			options.failure = function(statusCode, e){
				console.log('[ibc-js]', name, ' - failure:', statusCode, e);
				if(cb) cb(eFmt('invoke() error', statusCode, e), null);
			};
			rest.post(options, '', body);
		};
	}
}

//==================================================================
//build_query_func() - create JS function that calls the custom goLang function in the chaincode
//==================================================================
function build_query_func(name){
	if(ibc.chaincode[name] != null){												//skip if already exists
		//console.log('[ibc-js] \t skip, func', name, 'already exists');
	}
	else {
		console.log('[ibc-js] Found cc query function: ', name);
		ibc.chaincode.details.func.push(name);
		ibc.chaincode[name] = function(args, username, cb){							//create the function in the chaincode obj
			if(typeof username === 'function'){ 									//if cb is in 2nd param use known username
				cb = username;
				username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
			}
			if(username == null) {													//if username not provided, use known valid one
				username = ibc.chaincode.details.peers[ibc.selectedPeer].user;
			}

			var options = {path: '/devops/query'};
			var body = {
					chaincodeSpec: {
						type: 'GOLANG',
						chaincodeID: {
							name: ibc.chaincode.details.deployed_name,
						},
						ctorMsg: {
							function: name,
							args: args
						},
						secureContext: username
					}
			};

			options.success = function(statusCode, data){
				console.log('[ibc-js]', name, ' - success:', data);
				ibc.q.push(Date.now());												//new action, add it to queue
				if(cb) cb(null, data);
			};
			options.failure = function(statusCode, e){
				console.log('[ibc-js]', name, ' - failure:', statusCode, e);
				if(cb) cb(eFmt('invoke() error', statusCode, e), null);
			};
			rest.post(options, '', body);
		};
	}
}

//==================================================================
//filter_users() - return only client level usernames - [1=client, 2=nvp, 4=vp, 8=auditor accurate as of 2/18]
//==================================================================
function filter_users(users){														//this is only needed in a permissioned network
	var valid_users = [];
	for(var i = 0; i < users.length; i++) {
		if(users[i].username.indexOf('user_type1') === 0){							//type should be 1 for client
			valid_users.push(users[i]);
		}
	}
	return valid_users;
}

//==================================================================
//eFmt() - format errors
//==================================================================
function eFmt(name, code, details){													//my error format
	return 	{
		name: String(name),															//error short name
		code: Number(code),															//http code when applicable
		details: details															//error description
	};
}

module.exports = ibc;