'use strict';
'require view';
'require fs';

var LOG = '/tmp/speedcheck.log';

return view.extend({
	pollLog: function(budget, logEl, statusEl, btn, tries) {
		var view = this;
		tries = tries || 0;

		return fs.exec('/bin/cat', [LOG]).then(function(res) {
			var text = (res && res.stdout) ? res.stdout : '';
			if (text) logEl.textContent = text;

			var m = text.match(/平均(下行|上行)\s*:\s*(\d+)\s*Mbps/);
			if (m) {
				statusEl.textContent = '完成 ✓ 平均' + m[1] + ' ' + m[2] + ' Mbps';
				btn.disabled = false;
				return;
			}
			if (text.indexOf('错误') !== -1) {
				statusEl.textContent = '出错，详见下方输出';
				btn.disabled = false;
				return;
			}
			if (tries * 2 > budget) {
				statusEl.textContent = '超时未完成，请检查脚本或网络';
				btn.disabled = false;
				return;
			}
			statusEl.textContent = '进行中…(' + (tries * 2) + 's)';
			setTimeout(function() { view.pollLog(budget, logEl, statusEl, btn, tries + 1); }, 2000);
		}).catch(function(err) {
			statusEl.textContent = '读取日志失败: ' + (err && err.message ? err.message : err);
			btn.disabled = false;
		});
	},

	start: function(mode, dur, conn, url, ulsize, logEl, statusEl, btn) {
		var view = this;
		btn.disabled = true;
		logEl.textContent = '';
		statusEl.textContent = '启动中…';

		// 与设备上已验证可行的方式一致: /bin/sh -c 启动, 输出重定向到 /dev/null,
		// 日志由 speedcheck.sh start 分支自己写入 /tmp/speedcheck.log
		var cmd;
		if (mode === 'upload') {
			cmd = '/usr/bin/speedcheck.sh upload-start ' + ulsize;
		} else {
			cmd = '/usr/bin/speedcheck.sh start ' + dur + ' ' + conn;
			if (url) cmd += ' "' + url.replace(/["`$\\]/g, '') + '"';
		}
		cmd += ' >/dev/null 2>&1';

		return fs.exec('/bin/sh', ['-c', cmd]).then(function() {
			var budget = (mode === 'upload') ? ulsize * 8 + 60 : dur + 90;
			view.pollLog(budget, logEl, statusEl, btn);
		}).catch(function(err) {
			statusEl.textContent = '启动失败: ' + (err && err.message ? err.message : err);
			btn.disabled = false;
		});
	},

	render: function() {
		var view = this;

		var durInput = E('input', { type: 'number', value: '20', min: '5', max: '120', style: 'width:64px' });
		var connInput = E('input', { type: 'number', value: '4', min: '1', max: '16', style: 'width:64px' });
		var urlInput = E('input', { type: 'text', value: 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso', style: 'width:70%;max-width:640px' });
		var ulInput = E('select', { style: 'width:90px' }, [
			E('option', { value: '30' }, '30 MB'),
			E('option', { value: '50', selected: 'selected' }, '50 MB'),
			E('option', { value: '100' }, '100 MB')
		]);

		var statusEl = E('p', { style: 'font-weight:bold' }, '空闲');
		var logEl = E('pre', { style: 'background:#111;color:#7f7;padding:10px;border-radius:6px;min-height:120px;white-space:pre-wrap;font-size:13px' }, '');

		var dlBtn = E('button', {
			class: 'cbi-button cbi-button-apply',
			click: function(ev) {
				ev.preventDefault();
				view.start('download',
					parseInt(durInput.value, 10) || 20,
					parseInt(connInput.value, 10) || 4,
					urlInput.value.trim(), 0,
					logEl, statusEl, dlBtn);
			}
		}, '开始测速');

		var ulBtn = E('button', {
			class: 'cbi-button cbi-button-action',
			click: function(ev) {
				ev.preventDefault();
				view.start('upload', 0, 0, '',
					parseInt(ulInput.value, 10) || 50,
					logEl, statusEl, ulBtn);
			}
		}, '测试上传');

		return E('div', { class: 'cbi-map' }, [
			E('h2', {}, '真实带宽测试'),
			E('div', { class: 'cbi-section' }, [
				E('p', {}, '原理: 统计 WAN 口网卡真实收发字节。下载为多连接拉取 CDN 大文件;'
					+ '上传为 POST 到 Cloudflare 官方测速端点。均不经过 speedtest.net 节点,'
					+ '不受节点拥堵影响。测试期间请避免其他大流量操作。'),

				E('div', { style: 'margin:12px 0' }, [
					'时长(秒) ', durInput, ' \u00a0 连接数 ', connInput, ' \u00a0 ', dlBtn
				]),
				E('div', { style: 'margin:12px 0' }, [
					'下载目标(URL) ', urlInput
				]),
				E('div', { style: 'margin:12px 0' }, [
					'上传数据量 ', ulInput, ' \u00a0 ', ulBtn,
					E('span', { style: 'color:#999;font-size:12px' },
						'  (上传需 curl)')
				]),
				statusEl,
				logEl
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
