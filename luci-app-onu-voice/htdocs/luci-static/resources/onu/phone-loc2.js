'use strict';
/*
 * phone-loc.js — 手机号段归属地离线查询（phone.dat 二进制 + 区号表）
 * 数据源: https://github.com/pangongzi/phone (2023-12, 51.7万条)
 * 用法: require onu.phone-loc2 as phoneloc; new phoneloc().lookup('18608992148')
 * 返回 Promise("海口 联通")（手机）/Promise("北京")（固话）/Promise('')（未命中）
 */
'require baseclass';

var _dv = null, _first = 0, _n = 0, _areas = {};

function load() {
	if (_dv) return Promise.resolve();
	return fetch(L.resource('view/onu/phone.dat')).then(function(r) {
		return r.arrayBuffer();
	}).then(function(b) {
		_dv = new DataView(b);
		_first = _dv.getUint32(4, true);
		_n = Math.floor((b.byteLength - _first) / 9);
		return fetch(L.resource('view/onu/area-codes.json')).then(function(r) {
			return r.json();
		}).then(function(a) {
			_areas = {};
			/* 键统一去前导 0（"010"/"0898" → "10"/"898"），查询侧同样去 0 后匹配 */
			for (var k in (a || {})) {
				var nk = k.replace(/^0+/, '');
				_areas[nk || k] = a[k];
			}
		});
	});
}

/* 索引区二分：每项 9 字节 = uint32 前七位 + int32 记录偏移 + uint8 卡类型 */
function findRec(prefix7) {
	var lo = 0, hi = _n - 1, target = prefix7 | 0;
	while (lo <= hi) {
		var mid = (lo + hi) >> 1;
		var off = _first + mid * 9;
		var p = _dv.getUint32(off, true);
		if (p === target) {
			var ro = _dv.getInt32(off + 4, true);
			var ct = _dv.getUint8(off + 8);
			/* 记录区：省|市|邮编|区号\0 */
			var end = ro;
			while (_dv.getUint8(end) !== 0) end++;
			var parts = (new TextDecoder('utf-8')).decode(
				new Uint8Array(_dv.buffer, ro, end - ro)).split('|');
			return { prov: parts[0] || '', city: parts[1] || '', area: parts[3] || '', card: ct };
		}
		if (p < target) lo = mid + 1; else hi = mid - 1;
	}
	return null;
}

var CARDS = { 1: '移动', 2: '联通', 3: '电信', 4: '电信虚拟', 5: '联通虚拟', 6: '移动虚拟' };

/* 本机所在地区号（去前导 0），用于无区号的本地固话归属判断 */
var LOCAL_AREA = '10';

return baseclass.extend({
	lookup: function(num) {
		return load().then(function() {
			var d = String(num || '').replace(/[^\d]/g, '');
			if (d.indexOf('86') === 0 && d.length > 11) d = d.substring(2);
			while (d.charAt(0) === '0' && d.length > 2) d = d.substring(1);
			if (/^1[3-9]\d{9}$/.test(d)) {
				/* 手机：前 7 位查号段（010... 去 0 后以 1 开头，必须先于固话判断） */
				var r = findRec(parseInt(d.substring(0, 7), 10));
				if (!r) return '';
				var loc = r.prov ? (r.city && r.city !== r.prov ? r.prov + ' ' + r.city : r.prov)
					: (r.city || '');
				return r.card ? (loc + ' ' + (CARDS[r.card] || '')) : loc;
			}
			if (d.length >= 7) {
				/* 固话：区号（去前导 0，3 位或 2 位）*/
				var a3 = d.substring(0, 3), a2 = d.substring(0, 2);
				if (_areas[a3]) return _areas[a3];
				if (_areas[a2]) return _areas[a2];
			}
			if (d.length >= 5 && d.length <= 8 && _areas[LOCAL_AREA]) {
				/* 本地固话（7~8 位，无区号）：按本机所在地区号归属 */
				return _areas[LOCAL_AREA];
			}
			return '';
		}).catch(function() { return ''; });
	}
});
