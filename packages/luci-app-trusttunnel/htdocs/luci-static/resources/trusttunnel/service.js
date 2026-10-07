'use strict';
'require baseclass';
'require rpc';

var callAction = rpc.declare({
	object: 'luci.trusttunnel', method: 'service', params: [ 'action' ]
});
var callResult = rpc.declare({
	object: 'luci.trusttunnel', method: 'service_result', params: [ 'job' ]
});

function waitForResult(res) {
	if (!res || !res.pending) return res;
	return new Promise(function(resolve) { window.setTimeout(resolve, 1000); })
		.then(function() { return callResult(res.job); })
		.then(waitForResult);
}

return baseclass.extend({
	run: function(action) { return callAction(action).then(waitForResult); }
});
