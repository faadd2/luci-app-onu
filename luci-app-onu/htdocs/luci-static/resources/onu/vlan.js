'use strict';
'require baseclass';
'require form';
'require uci';

/*
 * 通用接入 VLAN 编辑（四连接共用：wan/voip/iptv/tr069）
 * 泛化自 IPTV 页 _mvid 模式：VLAN ID 直接改写 network 配置的 8021q device 段——
 * 新建 pon0_<vid> 段（继承原段 MAC 地址）、接口 device 指向新设备名、删除旧段。
 * 保存走 LuCI 统一 uci.apply() 触发 network reload，无后端脚本。
 *
 * 注意：本 LuCI 的模块加载器会对导出执行 new（phone-loc2 同款约束），
 * 必须导出 baseclass.extend 类，不能导出纯对象。
 *
 * addOption(section, iface, label, descr) — section 为该接口的 form.NamedSection
 * 返回 form.Value 选项（调用方可追加 placeholder/depends 等）
 */
return baseclass.extend({
	addOption: function(s, iface, label, descr) {
		function parseVid(device) {
			var m = /^(pon0)\.(\d{1,4})$/.exec(device || '');
			return m ? m[2] : '';
		}
		function findDevSec(name) {
			var id = null;
			uci.sections('network', 'device', function(sec) {
				if (sec.name === name) id = sec['.name'];
			});
			return id;
		}

		var o = s.option(form.Value, '_vlan_' + iface, label, descr);
		o.datatype = 'range(1,4094)';
		o.cfgvalue = function() { return parseVid(uci.get('network', iface, 'device')); };
		o.write = function(sectionId, value) {
			if (!value) return;
			value = String(value);
			var newName = 'pon0.' + value;
			var oldName = uci.get('network', iface, 'device') || '';
			if (oldName === newName) return;
			var oldSec = findDevSec(oldName);
			var mac = oldSec ? uci.get('network', oldSec, 'macaddr') : null;
			var newSec = 'pon0_' + value;
			if (!uci.get('network', newSec))
				uci.add('network', 'device', newSec);
			uci.set('network', newSec, 'type', '8021q');
			uci.set('network', newSec, 'name', newName);
			uci.set('network', newSec, 'ifname', 'pon0');
			uci.set('network', newSec, 'vid', value);
			if (mac) uci.set('network', newSec, 'macaddr', mac);
			uci.set('network', iface, 'device', newName);
			if (oldSec && oldSec !== newSec)
				uci.remove('network', oldSec);
		};
		o.remove = function() {};
		return o;
	}
});
