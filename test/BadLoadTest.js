// Testing ibc.load_chaincode with bad input
// I expect this test to fail out, with err.message of bad zip url.

console.log("Now starting BadLoadTest.js");

// Starting out by requiring all dependancies
var test = require('tape');
var Ibc1 = require('..');

// Then define new instances.
var ibc = new Ibc1();
var chaincode = {};

// Define some options with a bad zip_url to see how the sdk catches it.
var badZipOptions = {
	zip_url: 'https://github.com/ibm-blockchain/marbles-chaincode/archive/master.zi',
	unzip_dir: 'marbles-chaincode-master/part2', 
	git_url: 'https://github.com/ibm-blockchain/marbles-chaincode/part2', 
	deployed_name: null 
};

// Call the load_chaincode function, knowing that it's getting the wrong zip_url.

test('Passing in a typo, expecting an invalid zip format error', function (t) {
	t.throws(function(){
  		ibc.load_chaincode(options, function cb_ready(err, cc) {});
	})
	t.end();
});

