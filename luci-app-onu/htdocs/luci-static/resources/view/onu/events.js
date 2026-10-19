'use strict';
'require dom';
'require fs';
'require poll';
'require ui';
'require uci';
'require view';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css') + '?v=3';
	document.head.appendChild(_onuCss);
}

/*
 * PON 事件日志页（增强版新增）
 * 板块1：airoha-pond 守护进程事件（pondctl events，JSONL 流）
 * 板块2：内核日志中的 PON 相关条目（logread -e airoha，自动刷新）
 */

var MAX_EVENTS = 200;

var kernLogTimer = null;

function lineSections() {
	return uci.sections('pon', 'xpon');
}

function parseEventLines(text) {
	var events = [];
	String(text || '').split('\n').forEach(function(line) {
		line = line.trim();
		if (!line)
			return;
		try {
			var ev = JSON.parse(line);
			events.push(ev);
		} catch (e) {}
	});
	return events;
}

function formatTime(ts) {
	var d = new Date(Number(ts));
	return isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

var kindLabels = {
	'lifecycle':         { cls: 'label-info',    text: 'lifecycle' },
	'ieee-oam':          { cls: 'label-success', text: 'IEEE OAM' },
	'ctc':               { cls: 'label-primary', text: 'CTC OAM' },
	'oam':               { cls: 'label-primary', text: 'OAM' },
	'omci':              { cls: 'label-primary', text: 'OMCI' },
	'registration':      { cls: 'label-warning', text: 'registration' },
	'alarm':             { cls: 'label-danger',  text: 'alarm' },
	'error':             { cls: 'label-danger',  text: 'error' }
};

function kindBadge(kind) {
	var k = kindLabels[kind] || { cls: 'label-info', text: kind || 'event' };
	return E('span', { 'class': 'label %s'.format(k.cls), 'style': 'margin-right:6px' }, k.text);
}

function renderEvents(events, emptyText) {
	if (!events.length)
		return E('p', {}, emptyText);
	var list = E('div', { 'style': 'max-height:420px;overflow-y:auto;font-family:monospace;font-size:12px' });
	events.slice(-MAX_EVENTS).reverse().forEach(function(ev) {
		list.appendChild(E('div', { 'style': 'padding:2px 0;border-bottom:1px dashed #eee' }, [
			E('span', { 'style': 'color:#999;margin-right:8px' }, formatTime(ev.timestamp_ms)),
			kindBadge(ev.kind),
			E('span', {}, ev.message || '')
		]));
	});
	return list;
}

function renderKernLog(text, filter) {
	var lines = String(text || '').split('\n').filter(function(l) { return l.trim(); });
	if (filter)
		lines = lines.filter(function(l) { return l.indexOf(filter) >= 0; });
	if (!lines.length)
		return E('p', {}, _('No matching log entries.'));
	var list = E('div', { 'style': 'max-height:420px;overflow-y:auto;font-family:monospace;font-size:12px' });
	lines.slice(-MAX_EVENTS).reverse().forEach(function(l) {
		var warn = l.indexOf('warn') >= 0 || l.indexOf('err') >= 0;
		list.appendChild(E('div', {
			'style': 'padding:2px 0;border-bottom:1px dashed #eee;word-break:break-all;' +
				(warn ? 'color:#c00;' : '')
		}, l));
	});
	return list;
}

return view.extend({
	load: function() {
		return uci.load('pon');
	},

	render: function() {
		var self = this;
		var lines = lineSections();
		var lineName = (lines[0] && lines[0]['.name']) || 'line0';
		var lineSelect = E('select', { 'class': 'cbi-input-select' }, lines.map(function(s) {
			return E('option', {
				'value': s['.name'],
				'selected': s['.name'] === lineName ? '' : null
			}, '%s (%s)'.format(s['.name'], s.device || '-'));
		}));

		var eventsBox = E('div', { 'id': 'pon-events-list' }, E('p', {}, _('Press "Refresh" to load events.')));
		var logFilter = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'placeholder': _('Filter…'),
			'style': 'width:200px',
			'input': function() { self.refreshKernLog(); }
		});
		var kernBox = E('div', { 'id': 'pon-kern-list' }, E('p', {}, _('Loading…')));

		var autoRefresh = E('input', { 'type': 'checkbox', 'checked': 'checked' });
		autoRefresh.addEventListener('change', function() {
			if (autoRefresh.checked)
				self.startKernPolling(kernBox, logFilter);
			else
				self.stopKernPolling();
		});

		this.kernBox = kernBox;
		this.logFilter = logFilter;

		var root = E('div', { 'class': 'cbi-map onu-scope' }, [
			E('h2', {}, _('PON event log')),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('PON daemon events')),
				E('p', { 'class': 'cbi-value-description' },
					_('Events reported by airoha-pond: OAM discovery, CTC exchanges, registration and alarms. Reading the event stream stops automatically after 2 seconds.')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('PON line')),
					E('div', { 'class': 'cbi-value-field' }, [
						lineSelect, ' ',
						E('button', {
							'class': 'cbi-button cbi-button-action',
							'click': ui.createHandlerFn(this, 'refreshEvents', lineSelect, eventsBox)
						}, _('Refresh'))
					])
				]),
				eventsBox
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Kernel log (PON)')),
				E('p', { 'class': 'cbi-value-description' },
					_('Kernel messages from the airoha-xpon driver, including "EPON MAC error interrupt" lines.')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Filter')),
					E('div', { 'class': 'cbi-value-field' }, [
						logFilter, ' ',
						E('label', { 'style': 'margin-left:12px' }, [
							autoRefresh, ' ', _('Auto refresh (5s)')
						])
					])
				]),
				kernBox
			])
		]);

		this.startKernPolling(kernBox, logFilter);

		return root;
	},

	refreshEvents: function(lineSelect, box) {
		box.innerHTML = '';
		box.appendChild(E('p', {}, _('Loading…')));
		/* pondctl events 会持续跟随，用 timeout 掐头取缓冲 */
		return L.resolveDefault(fs.exec('/usr/bin/timeout', ['2', 'pondctl', 'events', '--line', lineSelect.value]), null)
			.then(function(result) {
				var events = parseEventLines(result ? result.stdout : '');
				dom.content(box, renderEvents(events, _('No events reported by the daemon yet.')));
			});
	},

	refreshKernLog: function() {
		var box = this.kernBox, filter = this.logFilter;
		if (!box)
			return Promise.resolve();
		return L.resolveDefault(fs.exec_direct('/sbin/logread', ['-e', 'airoha']), '')
			.then(function(text) {
				dom.content(box, renderKernLog(text, filter.value.trim()));
			});
	},

	startKernPolling: function() {
		this.stopKernPolling();
		this.refreshKernLog();
		kernLogTimer = poll.add(L.bind(this.refreshKernLog, this), 5);
	},

	stopKernPolling: function() {
		if (kernLogTimer != null) {
			poll.remove(kernLogTimer);
			kernLogTimer = null;
		}
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
