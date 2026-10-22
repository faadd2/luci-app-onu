'use strict';
/*
 * 传真管理（语音页「传真」标签内容）。
 * 约束：本 LuCI 模块加载器对导出执行 new——必须导出 baseclass.extend 类，
 *       不能导出纯对象（否则报 "factory yields invalid constructor"）。
 * 用法：'require onu.voice-fax as voicefax'; voicefax.build() -> Promise<Element>
 */
'require baseclass';
'require dom';
'require fs';
'require ui';

function fmtSize(n){n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';}
function fmtTime(ep){ep=Number(ep)||0;if(!ep)return '-';var d=new Date(ep*1000);function p(x){return (x<10?'0':'')+x;}return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());}
function b64ToBlob(b64){var bin=atob(b64);var len=bin.length;var bytes=new Uint8Array(len);for(var i=0;i<len;i++)bytes[i]=bin.charCodeAt(i);return new Blob([bytes],{type:'application/octet-stream'});}
function fileToB64(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){var s=String(r.result);var i=s.indexOf(',');res(i>=0?s.slice(i+1):s);};r.onerror=rej;r.readAsDataURL(file);});}

return baseclass.extend({
	build:function(){
		var numInput=null;

		function notify(msg,level){ui.addNotification(null,E('p',{},msg),level||'info');}
		function refresh(){location.reload();}

		function download(box,name){
			return fs.exec_direct('/usr/libexec/onu-fax-get',[box,name]).then(function(b64){
				var blob=b64ToBlob(String(b64||'').replace(/\s+/g,''));
				var a=document.createElement('a');
				a.href=URL.createObjectURL(blob);
				a.download=name;
				document.body.appendChild(a);a.click();
				setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1000);
			}).catch(function(err){notify('下载失败：'+((err&&err.message)||err),'error');});
		}

		function removeFile(box,name){
			return fs.exec_direct('/usr/libexec/onu-fax-rm',[box,name]).then(function(out){
				var res={};try{res=JSON.parse(out);}catch(e){res={ok:false};}
				notify(res.ok?'已删除：'+name:(res.msg||'删除失败'),res.ok?'info':'warning');
				if(res.ok)refresh();
			});
		}

		function sendOut(name){
			var num=(numInput.value||'').trim();
			if(!num){notify('请先填写对方号码','warning');return Promise.resolve();}
			return fs.exec_direct('/usr/libexec/onu-fax-send',[num,name]).then(function(out){
				var res={};try{res=JSON.parse(out);}catch(e){res={ok:false,msg:out};}
				notify(res.msg||'已提交发送',res.ok?'info':'warning');
				if(res.ok)refresh();
			});
		}

		function uploadAndSend(){
			var num=(numInput.value||'').trim();
			var fi=document.getElementById('onu-fax-file');
			if(!num){notify('请填写对方号码','warning');return Promise.resolve();}
			if(!fi.files||!fi.files.length){notify('请选择 TIFF 文件','warning');return Promise.resolve();}
			var file=fi.files[0];
			if(!/\.tiff?$/i.test(file.name)){notify('只支持 .tif/.tiff 文件','warning');return Promise.resolve();}
			return fileToB64(file).then(function(b64){
				return fs.write('/tmp/fax_upload.b64',b64);
			}).then(function(){
				return fs.exec_direct('/usr/libexec/onu-fax-put',[file.name]);
			}).then(function(out){
				var res={};try{res=JSON.parse(out);}catch(e){res={ok:false,msg:out};}
				if(!res.ok){notify('上传失败：'+(res.msg||''),'warning');return Promise.resolve();}
				return fs.exec_direct('/usr/libexec/onu-fax-send',[num,file.name]);
			}).then(function(out){
				if(!out)return;
				var res={};try{res=JSON.parse(out);}catch(e){res={ok:false,msg:out};}
				notify(res.msg||'已提交发送',res.ok?'info':'warning');
				if(res.ok)refresh();
			}).catch(function(err){notify('发送失败：'+((err&&err.message)||err),'error');});
		}

		function fileRow(box,f,canSend){
			return E('tr',{'class':'tr'},[
				E('td',{'class':'td left'},E('var',{},f.name)),
				E('td',{'class':'td left'},fmtSize(f.size)),
				E('td',{'class':'td left'},fmtTime(f.mtime)),
				E('td',{'class':'td left','style':'white-space:nowrap'},
					E('button',{'class':'btn cbi-button cbi-button-action','click':function(){return download(box,f.name);}},'下载'),
					' ',
					canSend?E('button',{'class':'btn cbi-button cbi-button-apply','click':function(){return sendOut(f.name);}},'发送'):'',
					canSend?' ':'',
					E('button',{'class':'btn cbi-button cbi-button-remove','click':function(){return removeFile(box,f.name);}},'删除'))
			]);
		}

		// 组装表格行：children 必须扁平——不内联 map() 结果（嵌套数组会被 E() 字符串化）
		function fileTable(box,list,emptyText,canSend,timeCol){
			var rows=[E('tr',{'class':'tr table-titles'},[
				E('th',{'class':'th left'},'文件'),E('th',{'class':'th left'},'大小'),
				E('th',{'class':'th left'},timeCol),E('th',{'class':'th left'},'操作')])];
			if(list.length)
				list.forEach(function(f){rows.push(fileRow(box,f,canSend));});
			else
				rows.push(E('tr',{'class':'tr'},E('td',{'class':'td left','colspan':'4'},emptyText)));
			return E('table',{'class':'table'},rows);
		}

		return fs.exec_direct('/usr/libexec/onu-fax-status',[]).then(function(out){
			var st={};try{st=JSON.parse(out)||{};}catch(e){}
			var inbox=st.inbox||[],outbox=st.outbox||[],sent=st.sent||[];
			numInput=E('input',{'id':'onu-fax-num','type':'text','placeholder':'对方号码（如 010XXXXXXXX 或手机号）','style':'width:16em;margin-right:0.5em'});

			return E('div',{},[
				E('p',{},'Asterisk 7x24 值守收传真（T.38 / G.711 自动协商）。来电检测到传真音自动转入接收，普通电话不受影响。传真保存在设备闪存（/overlay/fax），重启不丢。'),
				E('h3',{},'收件箱'),
				fileTable('inbox',inbox,'收件箱为空。收到传真后自动出现在这里。',false,'时间'),
				E('h3',{},'发送传真'),
				E('div',{'class':'cbi-section','style':'padding:0.5em 1em'},[
					E('p',{},[numInput,
						E('input',{'id':'onu-fax-file','type':'file','accept':'.tif,.tiff','style':'margin-right:0.5em'}),
						E('button',{'class':'btn cbi-button cbi-button-apply','click':function(){return uploadAndSend();}},'上传并发送')]),
					E('p',{'class':'cbi-value-description'},'上传 TIFF 文件并立即拨打对方传真号码；也可先留存在发件箱，之后点「发送」。')
				]),
				E('h4',{},'发件箱'),
				fileTable('outbox',outbox,'发件箱为空。',true,'入库时间'),
				E('h4',{},'发件记录（已发送）'),
				fileTable('sent',sent,'暂无已发送传真。',false,'完成时间'),
				E('h4',{},'最近记录'),
				E('pre',{'style':'font-size:12px'},[(st.inbox_log||[]).concat(st.sent_log||[])].join('\n')||'（无）'),
				E('div',{'style':'margin-top:1em'},
					E('button',{'class':'btn cbi-button','click':function(){location.reload();}},'刷新'))
			]);
		}).catch(function(err){
			return E('div',{},E('p',{'class':'label label-danger'},'传真状态读取失败：'+((err&&err.message)||err)));
		});
	}
});
