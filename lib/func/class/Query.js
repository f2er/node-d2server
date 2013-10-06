/**
 * 创建队列来管理任务
 *
 * @param  {Function} endCall 队列结束时运行的函数
 */
module.exports = require('../../mod.js').load('inherits').init(function(endCall){
	this.endCall = this.endCall;
}, {
	'init': function(){
		this.list = [];
		this.index = -1;
		// 创建可赋值的方法
		this.nextDR = this.next.bind(this);
		this.endDR = this.end.bind(this);
	},
	'add': function(endCall){
		this.list.push(endCall);
	},
	'start': function(){
		if (this.isDoing()) return false;
		this.next();
		return true;
	},
	'end': function(){
		if (this.endCall) this.endCall(this.list.length - this.index -1);
	},
	'next': function(){
		if (++this.index < this.list.length) {
			this.list[this.index](this.nextDR, this.endDR);
		} else {
			this.end();
		}
	},
	'isDoing': function(){
		return this.index != -1;
	},
	'reset': function(){
		if (!this.isDoing()) return false;
		this.index = -1;
		return true;
	}
});