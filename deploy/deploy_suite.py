# -*- coding: utf-8 -*-
"""把超级 ONU 套件直装到 ZN504XG-D：上传视图/菜单/ACL，清理旧 luci-app-pon，重启服务"""
import os, subprocess, sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(BASE, '..'))
DEV = os.path.join(BASE, '..', '..', 'scripts')
ONU = os.path.join(BASE, '..', 'luci-app-onu')
VIEWS = ['status.js', 'optical.js', 'config.js', 'hardware.js', 'events.js', 'diagnostics.js']

def ssh(cmd, t=90):
    r = subprocess.run([sys.executable, os.path.join(DEV, 'device_ssh.py'), cmd],
                       capture_output=True, text=True, timeout=t)
    return r.stdout + r.stderr

def up(local, remote):
    r = subprocess.run([sys.executable, os.path.join(DEV, 'chunk_upload.py'), local, remote],
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        print(r.stdout, r.stderr); sys.exit('upload failed: ' + remote)
    print('up ->', remote)

# 1) 核心视图（zh-inline 免 lmo）+ css
for f in VIEWS:
    up(os.path.join(ONU, 'htdocs/luci-static/resources/view/onu/_zh_inline', f), '/tmp/onu-' + f)
up(os.path.join(ONU, 'htdocs/luci-static/resources/view/onu/onu.css'), '/tmp/onu-onu.css')

# 2) 业务模块视图（中文原生）
for f in ['internet', 'iptv', 'voice', 'mgmt']:
    up(os.path.join(REPO, 'luci-app-onu-%s/htdocs/luci-static/resources/view/onu/%s.js' % (f, f)),
       '/tmp/onu-%s.js' % f)
up(os.path.join(REPO, 'luci-app-onu-migrate/htdocs/luci-static/resources/view/onu/migrate.js'),
   '/tmp/onu-migrate.js')
up(os.path.join(REPO, 'luci-app-onu-migrate/htdocs/luci-static/resources/onu-migrate/parser.js'),
   '/tmp/onu-migrate-parser.js')

# 3) 菜单与 ACL（4+4 个文件打包一次传）
import io, tarfile
buf = io.BytesIO()
tf = tarfile.open(fileobj=buf, mode='w:gz')
pairs = [
    (os.path.join(ONU, 'root/usr/share/luci/menu.d/luci-app-onu.json'), 'menu-core.json'),
    (os.path.join(ONU, 'root/usr/share/rpcd/acl.d/luci-app-onu.json'), 'acl-core.json'),
]
for f in ['internet', 'iptv', 'voice', 'mgmt']:
    pairs.append((os.path.join(REPO, 'luci-app-onu-%s/root/usr/share/luci/menu.d/luci-app-onu-%s.json' % (f, f)), 'menu-%s.json' % f))
    pairs.append((os.path.join(REPO, 'luci-app-onu-%s/root/usr/share/rpcd/acl.d/luci-app-onu-%s.json' % (f, f)), 'acl-%s.json' % f))
f = 'migrate'
pairs.append((os.path.join(REPO, 'luci-app-onu-%s/root/usr/share/luci/menu.d/luci-app-onu-%s.json' % (f, f)), 'menu-%s.json' % f))
pairs.append((os.path.join(REPO, 'luci-app-onu-%s/root/usr/share/rpcd/acl.d/luci-app-onu-%s.json' % (f, f)), 'acl-%s.json' % f))
for src, arc in pairs:
    tf.add(src, arcname=arc)
tf.close()
tmp = os.path.join(BASE, '_deploy.tar.gz')
open(tmp, 'wb').write(buf.getvalue())
up(tmp, '/tmp/onu-deploy.tar.gz')
os.remove(tmp)

print(ssh('set -e; '
    'mkdir -p /www/luci-static/resources/view/onu; '
    'cd /tmp; '
    + ' '.join('mv onu-%s /www/luci-static/resources/view/onu/%s;' % (f, f) for f in VIEWS)
    + ' mv onu-onu.css /www/luci-static/resources/view/onu/onu.css;'
    + ' '.join('mv onu-%s.js /www/luci-static/resources/view/onu/%s.js;' % (f, f) for f in ['internet', 'iptv', 'voice', 'mgmt'])
    + ' mv onu-migrate.js /www/luci-static/resources/view/onu/migrate.js;'
    + ' mkdir -p /www/luci-static/resources/onu-migrate;'
    + ' mv onu-migrate-parser.js /www/luci-static/resources/onu-migrate/parser.js;'
    + ' tar xzf onu-deploy.tar.gz;'
    ' mv menu-core.json /usr/share/luci/menu.d/luci-app-onu.json;'
    ' mv acl-core.json /usr/share/rpcd/acl.d/luci-app-onu.json;'
    ' mv menu-internet.json /usr/share/luci/menu.d/luci-app-onu-internet.json;'
    ' mv acl-internet.json /usr/share/rpcd/acl.d/luci-app-onu-internet.json;'
    ' mv menu-iptv.json /usr/share/luci/menu.d/luci-app-onu-iptv.json;'
    ' mv acl-iptv.json /usr/share/rpcd/acl.d/luci-app-onu-iptv.json;'
    ' mv menu-voice.json /usr/share/luci/menu.d/luci-app-onu-voice.json;'
    ' mv acl-voice.json /usr/share/rpcd/acl.d/luci-app-onu-voice.json;'
    ' mv menu-migrate.json /usr/share/luci/menu.d/luci-app-onu-migrate.json;'
    ' mv acl-migrate.json /usr/share/rpcd/acl.d/luci-app-onu-migrate.json;'
    ' rm -f onu-deploy.tar.gz;'
    # 清理旧 luci-app-pon（孤儿文件）
    ' rm -rf /www/luci-static/resources/view/pon;'
    ' rm -f /usr/share/rpcd/acl.d/luci-app-pon.json /usr/share/luci/menu.d/luci-app-pon.json;'
    ' rm -rf /tmp/luci-indexcache*;'
    '/etc/init.d/rpcd restart; /etc/init.d/uhttpd restart; sleep 2;'
    'ls /www/luci-static/resources/view/onu/ | tr "\\n" " "; echo;'
    'ls /usr/share/luci/menu.d/ | grep onu | tr "\\n" " "; echo;'
    'echo DEPLOY_DONE'))
