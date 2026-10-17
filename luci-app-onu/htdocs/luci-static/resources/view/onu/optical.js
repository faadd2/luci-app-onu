'use strict';
'require dom';
'require fs';
'require poll';
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

/*
 * 光链路质量页（增强版新增）
 * 数据源：ponctl status --json（光功率/计数器）+ debugfs PCS/FEC 计数
 * 重点服务于 10G EPON "EPON MAC error interrupt: 0x0800" 误码诊断
 */

var HISTORY_MAX = 120;   /* 3s × 120 = 6 分钟窗口 */
var POLL_INTERVAL = 3;

var rxPowerHistory = [];
var uncorrectedHistory = [];
var lastSample = null;

function parseDebugfs(text) {
	var out = {};
	if (text == null)
		return out;
	String(text).split('\n').forEach(function(line) {
		var m = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
		if (m)
			out[m[1]] = m[2].trim();
	});
	return out;
}

function num(value) {
	var n = Number(value);
	return isNaN(n) ? null : n;
}

function fmtInt(value) {
	var n = num(value);
	return n == null ? '-' : n.toLocaleString('en-US');
}

function fmtRate(perSec) {
	if (perSec == null)
		return '-';
	if (perSec >= 1000000)
		return (perSec / 1000000).toFixed(2) + ' M/s';
	if (perSec >= 1000)
		return (perSec / 1000).toFixed(2) + ' K/s';
	return perSec.toFixed(1) + ' /s';
}

/* 接收光功率评级 */
function rxPowerGrade(p) {
	if (p == null)  return { label: _('Unknown'),      cls: 'label-warning' };
	if (p >= -20)   return { label: _('Excellent'),    cls: 'label-success' };
	if (p >= -24)   return { label: _('Good'),         cls: 'label-primary' };
	if (p >= -27)   return { label: _('Weak'),         cls: 'label-warning' };
	return             { label: _('Critical'),     cls: 'label-danger'  };
}

/* FEC 误码评级 */
function fecGrade(uncorrectedPerSec, ratio) {
	if (uncorrectedPerSec == null)
		return { label: _('Collecting…'), cls: 'label-warning' };
	if (uncorrectedPerSec > 1000 || (ratio != null && ratio > 0.01))
		return { label: _('Severe bit errors'), cls: 'label-danger' };
	if (uncorrectedPerSec > 0 || (ratio != null && ratio > 0.0001))
		return { label: _('Bit errors present'), cls: 'label-warning' };
	return { label: _('Clean'), cls: 'label-success' };
}

function badge(grade) {
	return E('span', { 'class': 'label %s'.format(grade.cls) }, grade.label);
}

function row(label, value) {
	/* 数组/DOM 节点直接交给 E() 展开；只有基本类型才 String()，
	 * 否则数组会被逗号拼接、节点会变成 "[object HTMLSpanElement]"。 */
	if (value == null || value === '')
		value = '-';
	else if (typeof value !== 'object')
		value = String(value);
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'style': 'width: 45%' }, label),
		E('td', { 'class': 'td left' }, value)
	]);
}

function section(title, rows) {
	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, title),
		E('table', { 'class': 'table' }, rows)
	]);
}

/* 轻量 sparkline：polyline + 网格 + 标注；支持 null 缺口（计数器复位） */
function sparkline(canvas, data, color, unit) {
	var dpr = window.devicePixelRatio || 1;
	var w = canvas.clientWidth || 600, h = 80;
	canvas.width = w * dpr; canvas.height = h * dpr;
	canvas.style.height = h + 'px';
	var ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);
	ctx.clearRect(0, 0, w, h);

	var vals = data.filter(function(v) { return v != null; });
	if (!vals.length) {
		ctx.fillStyle = '#999'; ctx.font = '11px sans-serif';
		ctx.fillText(_('Collecting samples…'), 6, h / 2);
		return;
	}

	var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
	/* 恒定值序列：人为扩展量程让线居中显示，避免挤成一条并消除标签重叠 */
	if (max - min < 1e-9) {
		var pad = Math.abs(max) > 1e-9 ? Math.abs(max) * 0.05 : 1;
		min -= pad; max += pad;
	}
	var span = max - min;

	var labelW = 72, plotW = Math.max(10, w - labelW - 8);

	/* 横向网格 + 上/中/下三档标注（分开画，永不重叠） */
	ctx.strokeStyle = 'rgba(128,128,128,0.18)';
	ctx.fillStyle = '#888'; ctx.font = '10px sans-serif';
	[min, (min + max) / 2, max].forEach(function(v) {
		var y = h - 6 - ((v - min) / span) * (h - 12);
		ctx.beginPath(); ctx.moveTo(2, y); ctx.lineTo(2 + plotW, y); ctx.stroke();
		var txt = v.toFixed(Math.abs(v) < 10 ? 2 : 1) + ' ' + unit;
		ctx.fillText(txt, 2 + plotW + 5, y + 3);
	});

	/* 折线；null 样本断开（计数器复位期间的缺口，不伪造 0） */
	ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
	var started = false;
	data.forEach(function(v, i) {
		if (v == null) { started = false; return; }
		var x = 2 + (i / (HISTORY_MAX - 1)) * plotW;
		var y = h - 6 - ((v - min) / span) * (h - 12);
		started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		started = true;
	});
	ctx.stroke();

	/* 末值圆点 */
	var lastV = null, lastI = 0;
	for (var i = data.length - 1; i >= 0; i--)
		if (data[i] != null) { lastV = data[i]; lastI = i; break; }
	if (lastV != null) {
		var ly = h - 6 - ((lastV - min) / span) * (h - 12);
		var lx = 2 + (lastI / (HISTORY_MAX - 1)) * plotW;
		ctx.fillStyle = color;
		ctx.beginPath(); ctx.arc(lx, ly, 3, 0, 2 * Math.PI); ctx.fill();
	}
}

function firstLine() {
	var lines = uci.sections('pon', 'xpon');
	return (lines[0] && lines[0].device) || 'pon0';
}

function loadData() {
	var device = firstLine();
	return Promise.all([
		L.resolveDefault(fs.exec_direct('/usr/sbin/ponctl', ['--device', device, 'status', '--json']), null),
		L.resolveDefault(fs.read_direct('/sys/kernel/debug/airoha-xpon-pon0/pcs', 'text'), null),
		L.resolveDefault(fs.read_direct('/sys/kernel/debug/airoha-xpon-pon0/frontend', 'text'), null)
	]).then(function(results) {
		var status = null;
		try { status = JSON.parse(results[0]); } catch (e) {}
		return {
			status: status,
			pcs: parseDebugfs(results[1]),
			fe: parseDebugfs(results[2]),
			debugfsMissing: results[1] == null
		};
	});
}

function renderAll(data) {
	var status = data.status || {};
	var line = status.line || {};
	var reg = status.registration || {};
	var fe = status.frontend || {};
	var counters = status.counters || {};
	var pcs = data.pcs || {};
	var feD = data.fe || {};

	var rx = num(fe.rx_power_dbm != null ? fe.rx_power_dbm : feD.rx_power_dbm);
	var tx = num(fe.tx_power_dbm != null ? fe.tx_power_dbm : feD.tx_power_dbm);

	/* 采样历史（每轮渲染push一次，由 poll 驱动） */
	var uncorrected = num(pcs.uncorrected_codewords);
	var now = Date.now();
	if (lastSample && uncorrected != null && lastSample.uncorrected != null) {
		var dt = (now - lastSample.t) / 1000;
		if (dt > 0) {
			/* 计数器比上次小 = PCS 重训练复位了；记 null（缺口），
			 * 不能取 max(0,…)，否则会伪造一个 0 掩盖误码风暴 */
			var rate = (uncorrected >= lastSample.uncorrected)
				? (uncorrected - lastSample.uncorrected) / dt : null;
			uncorrectedHistory.push(rate);
			if (uncorrectedHistory.length > HISTORY_MAX) uncorrectedHistory.shift();
		}
	}
	if (rx != null) {
		rxPowerHistory.push(rx);
		if (rxPowerHistory.length > HISTORY_MAX) rxPowerHistory.shift();
	}
	lastSample = { t: now, uncorrected: uncorrected };

	var corrected = num(pcs.corrected_codewords);
	var noErr = num(pcs.no_error_codewords);
	var all = num(pcs.all_codewords);
	/* 错误率优先用 no_error 反推并钳制到 [0,1]：寄存器是活读的，
	 * 快照内也可能出现 corrected+uncorrected > all 的撕裂读数，
	 * 不钳制就会显示 103% 这类假值 */
	var fecRatio = null;
	if (all != null && all > 0) {
		if (noErr != null)
			fecRatio = Math.min(1, Math.max(0, (all - noErr) / all));
		else if (corrected != null && uncorrected != null)
			fecRatio = Math.min(1, Math.max(0, (corrected + uncorrected) / all));
	}
	var uncRate = uncorrectedHistory.length ? uncorrectedHistory[uncorrectedHistory.length - 1] : null;

	var nodes = [];

	/* MPCP 注册状态 → 友好标签（原始值为小写英文，主题会把徽标大写化） */
	var regState = reg.mpcp_state != null ? String(reg.mpcp_state).toLowerCase() : null;
	var regLabel = null;
	switch (regState) {
	case 'registered':    regLabel = _('Registered'); break;
	case 'registering':   regLabel = _('Registering'); break;
	case 'deregistered':  regLabel = _('Deregistered'); break;
	case 'denied':        regLabel = _('Registration denied'); break;
	case 'wait':          regLabel = _('Waiting for discovery'); break;
	default:              regLabel = regState || null;
	}

	/* 概要区 */
	nodes.push(E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Link quality summary')),
		E('table', { 'class': 'table' }, [
			row(_('Registration state'), regState != null
				? E('span', { 'class': 'label %s'.format(regState === 'registered' ? 'label-success' : 'label-warning') },
					regLabel || _('Unknown')) : '-'),
			row(_('Receive optical power'), [
				rx != null ? rx.toFixed(2) + ' dBm' : '-', ' ', badge(rxPowerGrade(rx))
			]),
			row(_('Transmit optical power'), tx != null ? tx.toFixed(2) + ' dBm' : '-'),
			row(_('Uncorrected FEC codewords'), [
				badge(fecGrade(uncRate, fecRatio)), ' ',
				uncorrected != null ? fmtInt(uncorrected) : _('Not available')
			]),
			row(_('FEC codeword error ratio'), fecRatio != null ? (fecRatio * 100).toFixed(4) + ' %' : '-')
		])
	]));

	/* 趋势图（独立区块布局，避开 cbi-value 栅格在主题里的挤压） */
	nodes.push(E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Trend (last %d minutes)').format(HISTORY_MAX * POLL_INTERVAL / 60)),
		E('div', { 'style': 'padding: 0.25rem 1rem 0.5rem' }, [
			E('div', { 'style': 'font-size:0.8125rem; color:#8898aa; margin-bottom:0.25rem' }, _('Rx power (dBm)')),
			E('canvas', { 'id': 'pon-optical-rx-spark', 'style': 'width:100%; height:80px; display:block' }),
			E('div', { 'style': 'font-size:0.8125rem; color:#8898aa; margin:0.75rem 0 0.25rem' }, _('Uncorrected FEC codewords per second')),
			E('canvas', { 'id': 'pon-optical-unc-spark', 'style': 'width:100%; height:80px; display:block' }),
			E('p', { 'class': 'cbi-value-description' },
				_('Samples are taken every %d seconds while this page is open. Open the page before cleaning the fiber end face or re-seating the connector to record a before/after comparison.').format(POLL_INTERVAL))
		])
	]));

	/* 光模块参数 */
	nodes.push(section(_('Optical module'), [
		row(_('Line mode'), line.active_mode || line.configured_mode),
		row(_('Line state'), line.lifecycle),
		row(_('PCS profile'), line.pcs_profile),
		row(_('PCS synchronized'), line.pcs_sync != null ? (line.pcs_sync ? _('Yes') : _('No')) : '-'),
		row(_('Temperature'), num(fe.temperature_celsius != null ? fe.temperature_celsius : feD.temperature_celsius) != null
			? Number(fe.temperature_celsius != null ? fe.temperature_celsius : feD.temperature_celsius).toFixed(1) + ' °C' : '-'),
		row(_('Supply voltage'), num(fe.voltage_volts != null ? fe.voltage_volts : feD.voltage_volts) != null
			? Number(fe.voltage_volts != null ? fe.voltage_volts : feD.voltage_volts).toFixed(2) + ' V' : '-'),
		row(_('Laser bias current'), num(fe.tx_bias_ma != null ? fe.tx_bias_ma : feD.tx_bias_ma) != null
			? Number(fe.tx_bias_ma != null ? fe.tx_bias_ma : feD.tx_bias_ma).toFixed(2) + ' mA' : '-'),
		row(_('Calibration data'), fe.calibration || feD.calibration),
		row(_('TX gate enabled'), fe.tx_gate_enabled != null
			? (fe.tx_gate_enabled ? _('Yes') : _('No')) : '-')
	]));

	/* FEC / PCS 计数器 */
	var rows = [
		row(_('Total FEC codewords'), fmtInt(pcs.all_codewords)),
		row(_('Codewords without errors'), fmtInt(pcs.no_error_codewords)),
		row(_('Corrected codewords'), fmtInt(pcs.corrected_codewords)),
		row(_('Uncorrectable codewords'), fmtInt(pcs.uncorrected_codewords)),
		row(_('Uncorrectable codeword rate'), fmtRate(uncRate)),
		row(_('FEC error bits'), fmtInt(pcs.error_bits)),
		row(_('FEC error bytes'), fmtInt(pcs.error_bytes)),
		row(_('FEC error seconds'), fmtInt(pcs.fec_error_seconds)),
		row(_('PCS interrupt status'), pcs.interrupt_status ? '0x' + Number(pcs.interrupt_status).toString(16) : '-'),
		row(_('MAC error counter (0x0800 source)'), fmtInt(counters.mac_errors))
	];
	if (data.debugfsMissing)
		rows.unshift(row(_('Debug interface'), [
			_('Not available (debugfs missing). Counters above come from ponctl only.'),
			E('br'), E('code', {}, 'mount -t debugfs none /sys/kernel/debug')
		]));
	nodes.push(section(_('FEC / PCS counters'), rows));

	/* 0x0800 提示 */
	nodes.push(E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('About "EPON MAC error interrupt: 0x0800"')),
		E('p', {}, _('On 10G-EPON links this interrupt fires when the FEC block reports uncorrectable codewords, which is almost always caused by a dirty or damaged fiber end face, a weak receiver, or a bad splice. Clean both end faces with alcohol wipes and inspect with a microscope. A healthy link shows an uncorrectable-codeword rate of zero.'))
	]));

	return nodes;
}

return view.extend({
	load: function() {
		return uci.load('pon').then(loadData);
	},

	render: function(data) {
		var container = E('div', { 'id': 'pon-optical' }, renderAll(data));
		var root = E('div', { 'class': 'cbi-map onu-scope' }, [
			E('h2', {}, _('Optical link')),
			container
		]);

		poll.add(function() {
			return loadData().then(function(d) {
				dom.content(container, renderAll(d));
				var c1 = container.querySelector('#pon-optical-rx-spark');
				var c2 = container.querySelector('#pon-optical-unc-spark');
				if (c1) sparkline(c1, rxPowerHistory, '#2c7be5', 'dBm');
				if (c2) sparkline(c2, uncorrectedHistory, '#e63757', '/s');
			});
		}, POLL_INTERVAL);

		/* 首帧画图 */
		requestAnimationFrame(function() {
			var c1 = container.querySelector('#pon-optical-rx-spark');
			var c2 = container.querySelector('#pon-optical-unc-spark');
			if (c1) sparkline(c1, rxPowerHistory, '#2c7be5', 'dBm');
			if (c2) sparkline(c2, uncorrectedHistory, '#e63757', '/s');
		});

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
