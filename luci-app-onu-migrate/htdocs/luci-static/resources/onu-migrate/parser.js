// SPDX-License-Identifier: Apache-2.0
// ZN504XG-D 配置导入解析器（一期原型）
// 输入：旧光猫配置备份文本（Youhua/Realtek romfile XML 或 CWMP/TR-069 SOAP）
// 输出：统一中间模型（纯 JSON，可序列化），供 LuCI 向导预览与 UCI 生成
//
// LuCI 模块约束（实测 PonWrt LuCI Master 26.275）：
// - 模块作用域只有 window/document/L 和 require 的类，没有 baseclass
// - 被 require 的模块必须返回 class（loader 检查 displayName）
// - Class.extend 的方法只挂 prototype，静态调用需在构造函数上另挂
// 故浏览器分支：view.extend(api) 造 class + Object.assign 挂静态。
// Node 测试走 module.exports（CommonJS 顶层 return 合法）。

'use strict';
'require view as view';

var api = (function (global) {
  'use strict';

  var SENSITIVE = /pass|passwd|password|secret|auth/i;

  // ---------- 格式探测 ----------

  function detectFormat(text) {
    if (/<Config_Information_File|<chain\s+chainName=/i.test(text)) return 'youhua-romfile';
    if (/<ROMFILE>/.test(text)) return 'ctromfile';
    if (/SetParameterValues|ParameterValueStruct|cwmp:/i.test(text)) return 'cwmp-soap';
    return 'unknown';
  }

  // ---------- Youhua/Realtek romfile XML ----------

  // 顶层 Name/Value 对（第一个 chain 之前）
  function parseFlatValues(text) {
    var out = {};
    var head = text.slice(0, text.search(/<chain\s+chainName=/i));
    var re = /<Value\s+Name="([^"]+)"\s+Value="([^"]*)"\s*\/>/g, m;
    while ((m = re.exec(head)) !== null) out[m[1]] = m[2];
    return out;
  }

  // 全部 chain 段：{ chainName: [ {param:value}, ... ] }（按出现顺序，含空段）
  function parseChains(text) {
    var chains = {};
    var re = /<chain\s+chainName="([^"]+)"[^>]*>([\s\S]*?)<\/chain>/g, m;
    while ((m = re.exec(text)) !== null) {
      var name = m[1], body = m[2];
      var entry = {};
      var vre = /<Value\s+Name="([^"]+)"\s+Value="([^"]*)"\s*\/>/g, vm;
      while ((vm = vre.exec(body)) !== null) entry[vm[1]] = vm[2];
      (chains[name] = chains[name] || []).push(entry);
    }
    return chains;
  }

  // Youhua applicationtype：北京联通实测对照（PT1570-R10 全量备份逐项核实）：
  // 1=管理通道(TR-069, 3969), 2=上网(3961), 4=IPTV(3962/3964), 8=语音(3010)
  // 注意：此映射随省份/批次可能不同；带 @rms 账号的条目强制归为管理通道兜底
  var APP_TYPE = { 1: 'management', 2: 'internet', 4: 'iptv', 8: 'voip' };

  function wanEntry(v, index) {
    if (!v || Object.keys(v).length === 0) return null;
    var mode = 'bridge';
    if ((v.pppUser || '') !== '') mode = 'pppoe';
    else if (parseInt(v.ConIPInstNum || '0', 10) > 0) mode = 'dhcp';
    // ConPPPInstNum>0 但无账号的条目（mgmt/iptv 常见）按桥接处理，避免误报 pppoe
    var app = parseInt(v.applicationtype || '0', 10);
    var service = APP_TYPE[app] || ('unknown-' + app);
    if (service === 'internet' && /@rms/i.test(v.pppUser || ''))
      service = 'management';
    var entry = {
      index: index,
      service: service,
      mode: mode,
      vlan: parseInt(v.vlan, 10) === 1 ? parseInt(v.vid, 10) : 0,
      prio: parseInt(v.vprio || '0', 10),
      enabled: parseInt(v.connDisable || '0', 10) === 0,
      mtu: parseInt(v.MTU || '1500', 10),
      igmp: parseInt(v.enableIGMP || '0', 10) === 1
    };
    if (mode === 'pppoe') {
      entry.username = v.pppUser || '';
      entry.password = v.pppPasswd || '';
    }
    return entry;
  }

  function parseYouhua(text) {
    var flat = parseFlatValues(text);
    var chains = parseChains(text);
    var wan = (chains.ATM_VC_TBL || []).map(wanEntry).filter(Boolean);
    var model = {
      format: 'youhua-romfile',
      device: {
        lan_ip: flat.LAN_IP_ADDR || '',
        lan_mask: flat.LAN_SUBNET || '',
        dhcp_server: flat.LAN_DHCP === '1',
        domain: flat.LAN_DHCP_DOMAIN || ''
      },
      wan: wan,
      igmp: {
        proxy: flat.IGMP_PROXY === '1',
        fast_leave: flat.IGMP_FASTLEAVE_ENABLE === '1',
        query_interval: parseInt(flat.IGMP_QUERY_INTERVAL || '0', 10) || null
      },
      voip: {
        // SIP 账号不在本文件中（VOIP_TBL 只有 DSP/音调参数），向导里手填或另导
        note: 'sip account not present in this backup format'
      },
      tr069: {
        acs_url: flat.ACSURL || flat.acs_url || '',
        platform_dist: flat.MIB_PLATFORM_DISTADDR_TBL || '',
        platform_bss: flat.MIB_PLATFORM_BSSADDR_TBL || ''
      },
      _raw: { app: 'youhua-romfile', chains: Object.keys(chains).length }
    };
    // voip vlan 从 wan 表里捞
    var voipWan = wan.filter(function (w) { return w.service === 'voip'; })[0];
    if (voipWan) model.voip.vlan = voipWan.vlan;
    return model;
  }

  // ---------- CWMP / TR-069 SOAP（SetParameterValues 报文或参数清单） ----------

  function parseCwmpSoap(text) {
    var params = {};
    var re = /<Name>([^<]+)<\/Name>\s*<Value(?:\s[^>]*)?>([\s\S]*?)<\/Value>/g, m;
    while ((m = re.exec(text)) !== null) params[m[1].trim()] = m[2].trim();

    var wan = [];
    // TR-098: InternetGatewayDevice.WANDevice.1.WANConnectionDevice.N.WANPPPConnection.M.*
    var groups = {};
    Object.keys(params).forEach(function (k) {
      var mm = k.match(/WANConnectionDevice\.(\d+)\.WAN(PPP|IP)Connection\.(\d+)\.(.+)$/);
      if (!mm) return;
      var key = mm[1] + ':' + mm[2] + ':' + mm[3];
      groups[key] = groups[key] || {};
      groups[key][mm[4]] = params[k];
    });
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      var mode = /X_CT-COM_VLANIDMark|Username/.test(Object.keys(g).join(' ')) && g.Username
        ? 'pppoe'
        : (g.ConnectionType || '').indexOf('PPP') >= 0 ? 'pppoe'
        : (g.ConnectionType || '').indexOf('IP') >= 0 ? 'dhcp' : 'bridge';
      var entry = {
        index: wan.length,
        service: 'unknown',
        mode: mode,
        vlan: parseInt(g['X_CT-COM_VLANIDMark'] || '0', 10),
        prio: parseInt(g['X_CT-COM_VLANIDMarkPriority'] || '0', 10),
        enabled: (g.Enable || '1') === '1',
        mtu: parseInt(g.MaxMTUSize || '1500', 10)
      };
      if (mode === 'pppoe') { entry.username = g.Username || ''; entry.password = g.Password || ''; }
      wan.push(entry);
    });

    return {
      format: 'cwmp-soap',
      device: {}, wan: wan,
      igmp: {}, voip: {}, tr069: { acs_url: params['InternetGatewayDevice.ManagementServer.URL'] || '' },
      _params_count: Object.keys(params).length,
      _raw: { app: 'cwmp-soap' }
    };
  }

  // ---------- 入口 ----------

  function parseConfigImport(text) {
    var fmt = detectFormat(text);
    if (fmt === 'youhua-romfile') return parseYouhua(text);
    if (fmt === 'cwmp-soap') return parseCwmpSoap(text);
    // ctromfile / unknown：返回空模型 + 提示
    return {
      format: fmt, device: {}, wan: [], igmp: {}, voip: {}, tr069: {},
      error: 'unsupported format: ' + fmt
    };
  }

  // 打印预览（自动打码敏感字段）
  function preview(model) {
    var clone = JSON.parse(JSON.stringify(model));
    (clone.wan || []).forEach(function (w) {
      ['username', 'password'].forEach(function (k) {
        if (w[k]) w[k] = String(w[k]).slice(0, 2) + '***';
      });
    });
    return clone;
  }

  return { parseConfigImport: parseConfigImport, detectFormat: detectFormat, preview: preview };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  // Node 测试环境（CommonJS 顶层 return 合法）
  module.exports = api;
  return;
}

// LuCI 分支：loader 只认模块顶层 return 的 class（isSubclass 校验 + 会 new 实例化）
// 实例上可直接调方法；__name__ 避免 AnonymousClass 命名。
return view.extend(Object.assign({ __name__: 'onu-migrate.parser' }, api));
