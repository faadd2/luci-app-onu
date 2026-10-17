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
			ui.addNotification(null, E('p', {}, _('Unable to create diagnostic package: %s').format(error.message)));
		}).finally(function() {
			button.disabled = false;
			button.classList.remove('spinning');
		});
	},

	handleRestart: function() {
		var button = document.getElementById('pon-debug-restart');
		if (!window.confirm(_('The PON line and OMCI/OAM interfaces will be stopped and restarted. Continue?')))
			return;
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER, ['restart']).then(function(output) {
			var result = JSON.parse(output);
			if (!result.ok)
				throw new Error(_('PON restart failed.'));
			ui.addNotification(null, E('p', {}, _('PON restart completed.')));
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, _('Unable to restart PON: %s').format(error.message)));
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
		if (!window.confirm(_('Switching the compatibility patch installs the selected airoha-pond binary and restarts the PON line. All services will drop for about a minute. Continue?')))
			return;
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER_PATCH, ['set', value]).then(function(output) {
			var result = JSON.parse(output);
			if (!result.ok)
				throw new Error(result.error || result.output || 'switch failed');
			ui.addNotification(null, E('p', {}, _('Patch switch applied: %s').format(result.output || 'ok')));
			window.setTimeout(function() { location.reload(); }, 2000);
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, _('Unable to switch patch: %s').format(error.message)));
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
		m = new form.Map('airoha-pon-debug', _('PON diagnostics'),
			_('Debug mode continuously keeps recent raw PON, OMCI and OAM packets in RAM. The setting remains enabled after reboot.'));
		m.chain('pon');
		m.readonly = !L.hasViewPermission();

		s = m.section(form.NamedSection, 'capture', 'capture', _('PON line'));
		o = s.option(form.DummyValue, '_devices', _('PON interface'));
		o.cfgvalue = function() {
			return uci.sections('pon', 'xpon').map(function(line) {
				return line.device || line['.name'];
			}).join(', ') || '-';
		};
		o = s.option(form.Flag, 'enabled', _('Debug mode'));
		o.default = o.disabled;
		o.rmempty = false;
		o.description = _('Enabling starts packet capture before a full PON restart. Disabling stops capture.');

		var patchStatus = null;
		try { patchStatus = patchStatusRaw ? JSON.parse(patchStatusRaw) : null; } catch (e) { patchStatus = null; }
		var active = patchStatus ? patchStatus.active : (patchInfo != null ? 'patched' : 'stock');
		var enabled = patchStatus ? patchStatus.enabled == 1 : true;

		var patchRows = [
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 45%' }, _('Patch status')),
				E('td', { 'class': 'td left' }, active == 'patched'
					? [ E('span', { 'class': 'label label-success', 'style': 'margin-right:6px' }, _('Patched')),
					    ' ', E('code', {}, (patchStatus && patchStatus.version) ? patchStatus.version.trim() : (patchInfo != null ? patchInfo.trim() : '')) ]
					: [ E('span', { 'class': 'label label-%s'.format(active == 'stock' ? 'warning' : 'danger'), 'style': 'margin-right:6px' },
						active == 'stock' ? _('Stock binary') : _('Unknown binary')),
					    ' ', E('code', {}, '/usr/sbin/airoha-pond') ])
			]),
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, _('Compatibility patch (Beijing Unicom 10G-EPON)')),
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
					}, _('Apply'))
				])
			])
		];

		var patchSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('PON patch information')),
			E('p', { 'class': 'cbi-value-description' },
				_('The compatibility patch makes airoha-pond answer unknown OAM SET/GET requests the way Beijing Unicom 10G-EPON provisioning requires. Without it registration succeeds but no data path opens. Disabling switches back to the stock binary and restarts the PON line.')),
			E('table', { 'class': 'table' }, patchRows)
		]);

		var opsSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Diagnostic operations')),
			E('p', {}, _('The package contains raw packet captures, PON state, system logs and network configuration.')),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'id': 'pon-debug-download',
					'disabled': m.readonly || null,
					'click': ui.createHandlerFn(this, 'handleDownload')
				}, _('Download diagnostic package')),
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'id': 'pon-debug-restart',
					'disabled': m.readonly || null,
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, _('Restart PON line'))
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
