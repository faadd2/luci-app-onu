include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-netspeedtest
PKG_VERSION:=5.2.1
PKG_RELEASE:=2

# sirpdboy netspeedtest, packaging bugs fixed locally:
#   - ACL gains uci read/write section
#   - script keeps exec bit, shebang works (bash dep declared)
#   - stale python3 deps dropped (LuCI-only files ship in this package)
LUCI_TITLE:=Net Speedtest (wan/iperf3/homebox, fixed packaging)
LUCI_DEPENDS:=+luci-base +bash +curl +iperf3
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
