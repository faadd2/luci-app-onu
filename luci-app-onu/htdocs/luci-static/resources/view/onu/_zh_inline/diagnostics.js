'use strict';
'require dom';
'require form';
'require fs';
'require ui';
'require uci';
'require view';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css');
	document.head.appendChild(_onuCss);
}

var HELPER = '/usr/libexec/airoha-pon-debug';
var HELPER_PATCH = '/usr/libexec/onu-pond-patch';
var BUNDLE = '/tmp/pon-debug.tar.gz';
var PATCH_INFO = '/etc/pon-fix-version';

function downloadBundle() {
	return fs.read_direct(BUNDLE, 'blob').then(function(blob) {
		var url = window.URL.createObjectURL(blob);
		var link = document.createElement('a');
		var now = new Date();
		link.style.display = 'none';
		link.href = url;
		link.download = 'pon-debug-' + now.toISOString().replace(/[:.]/g, '-') + '.tar.gz';
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.URL.revokeObjectURL(url);
	});
}

return view.extend({
	handleDownload: function() {
		var button = document.getElementById('pon-debug-download');
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER, ['collect']).then(downloadBundle).catch(function(error) {
			ui.addNotification(null, E('p', {}, '无法创建诊断包：%s'.format(error.message)));
		}).finally(function() {
			button.disabled = false;
			button.classList.remove('spinning');
		});
	},

	handleRestart: function() {
		var button = document.getElementById('pon-debug-restart');
		if (!window.confirm('PON 线路及 OMCI/OAM 接口将停止并重启，继续吗？'))
			return;
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER, ['restart']).then(function(output) {
			var result = JSON.parse(output);
			if (!result.ok)
				throw new Error('PON 重启失败。');
			ui.addNotification(null, E('p', {}, 'PON 重启完成。'));
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, '无法重启 PON：%s'.format(error.message)));
		}).finally(function() {
			button.disabled = false;
			button.classList.remove('spinning');
		});
	},

	load: function() {
		return Promise.all([
			L.resolveDefault(fs.read_direct(PATCH_INFO, 'text'), null),
			L.resolveDefault(fs.exec_direct(HELPER_PATCH, ['status']), null)
		]);
	},

	handlePatchToggle: function() {
		var checkbox = document.getElementById('onu-pond-patch-toggle');
		var button = document.getElementById('onu-pond-patch-apply');
		var value = checkbox.checked ? '1' : '0';
		if (!window.confirm('切换兼容性补丁会安装所选 airoha-pond 二进制并重启 PON 线路，所有业务将中断约一分钟。继续吗？'))
			return;
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER_PATCH, ['set', value]).then(function(output) {
			var result = JSON.parse(output);
			if (!result.ok)
				throw new Error(result.error || result.output || 'switch failed');
			ui.addNotification(null, E('p', {}, '补丁切换已应用：%s'.format(result.output || 'ok')));
			window.setTimeout(function() { location.reload(); }, 2000);
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, '无法切换补丁：%s'.format(error.message)));
		}).finally(function() {
			button.disabled = false;
			button.classList.remove('spinning');
		});
	},

	render: function(data) {
		/* LuCI(ucode dispatcher 版 luci.js) 将 load() 的 Promise.all 结果
		   整体作为单个参数传入 render；旧版按参数展开。两者都要兼容。 */
		var patchInfo = Array.isArray(data) ? data[0] : arguments[0];
		var patchStatusRaw = Array.isArray(data) ? data[1] : arguments[1];
		/* read_direct 在边界情况下可能回传非字符串，兜底为 null */
		if (patchInfo != null && typeof patchInfo !== 'string')
			patchInfo = null;
		var m, s, o;
		m = new form.Map('airoha-pon-debug', 'PON 诊断',
			'调试模式会在内存中持续保留最近的原始 PON、OMCI 和 OAM 报文，重启后仍然有效。');
		m.chain('pon');
		m.readonly = !L.hasViewPermission();

		s = m.section(form.NamedSection, 'capture', 'capture', 'PON 线路');
		o = s.option(form.DummyValue, '_devices', 'PON 接口');
		o.cfgvalue = function() {
			return uci.sections('pon', 'xpon').map(function(line) {
				return line.device || line['.name'];
			}).join(', ') || '-';
		};
		o = s.option(form.Flag, 'enabled', '调试模式');
		o.default = o.disabled;
		o.rmempty = false;
		o.description = '启用会先开始抓包再完整重启 PON；停用则停止抓包。';

		var patchStatus = null;
		try { patchStatus = patchStatusRaw ? JSON.parse(patchStatusRaw) : null; } catch (e) { patchStatus = null; }
		var active = patchStatus ? patchStatus.active : (patchInfo != null ? 'patched' : 'stock');
		var enabled = patchStatus ? patchStatus.enabled == 1 : true;

		var patchRows = [
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 45%' }, '补丁状态'),
				E('td', { 'class': 'td left' }, active == 'patched'
					? [ E('span', { 'class': 'label label-success', 'style': 'margin-right:6px' }, '已打补丁'),
					    ' ', E('code', {}, (patchStatus && patchStatus.version) ? patchStatus.version.trim() : (patchInfo != null ? patchInfo.trim() : '')) ]
					: [ E('span', { 'class': 'label label-%s'.format(active == 'stock' ? 'warning' : 'danger'), 'style': 'margin-right:6px' },
						active == 'stock' ? '原厂二进制' : '未知二进制'),
					    ' ', E('code', {}, '/usr/sbin/airoha-pond') ])
			]),
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, '兼容性补丁（北京联通 10G-EPON）'),
				E('td', { 'class': 'td left' }, [
					E('input', {
						'type': 'checkbox',
						'id': 'onu-pond-patch-toggle',
						'checked': enabled || null,
						'disabled': m.readonly || null
					}),
					' ',
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'id': 'onu-pond-patch-apply',
						'disabled': m.readonly || null,
						'click': ui.createHandlerFn(this, 'handlePatchToggle')
					}, '应用')
				])
			])
		];

		var patchSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, 'PON 补丁信息'),
			E('p', { 'class': 'cbi-value-description' },
				'兼容性补丁让 airoha-pond 按北京联通 10G-EPON 开通要求应答未知 OAM SET/GET 请求；不启用时注册可成功但永远不开数据通路。取消勾选将切回原厂二进制并重启 PON 线路。'),
			E('table', { 'class': 'table' }, patchRows)
		]);

		var opsSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '诊断操作'),
			E('p', {}, '诊断包包含原始报文抓包、PON 状态、系统日志和网络配置。'),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'id': 'pon-debug-download',
					'disabled': m.readonly || null,
					'click': ui.createHandlerFn(this, 'handleDownload')
				}, '下载诊断包'),
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'id': 'pon-debug-restart',
					'disabled': m.readonly || null,
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, '重启 PON 线路')
			])
		]);

		return m.render().then(function(map) {
			return E('div', { 'class': 'cbi-map onu-scope' }, [
				map,
				patchSection,
				opsSection
			]);
		});
	},

	handleSaveApply: null
});
