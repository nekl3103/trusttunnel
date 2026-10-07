# TrustTunnel for OpenWrt

[Русский](README.md) · [Releases](https://github.com/nekl3103/trusttunnel/releases) · [Guide](GUIDE.en.md) · [Issues](https://github.com/nekl3103/trusttunnel/issues)

Run TrustTunnel on your router and manage it through LuCI: multiple VPN servers, a separate exit for each site group, and routing rules for home devices. Phones, TVs and computers do not need their own VPN client.

This repository contains our OpenWrt integration: `luci-app-trusttunnel`, the installer, routing scripts, client management and tests. The VPN binary comes from [TrustTunnelClient](https://github.com/TrustTunnel/TrustTunnelClient). Configure a TrustTunnel server separately.

## Implemented features

- **Multiple servers:** configuration import including `tt://` links; a separate client process, TUN interface and routing table per enabled server. HTTP/2 and HTTP/3 (QUIC), TLS settings and pinned PEM certificates.
- **Geosite groups:** categories from `v2fly/domain-list-community`, additional domains and automatic list updates. Settings show selected groups; the full category catalog loads on request and is cached.
- **Per-group exit selection:** a fixed server, automatic pool selection, primary with fallback, or distribution of groups across healthy servers. Automatic selection supports latency, speed and reliability metrics.
- **Device rules:** assign groups by IP address, subnet or MAC address. With device routing enabled, only assigned device/group pairs use the VPN; other traffic stays direct.
- **Connection monitoring:** endpoint and tunnel checks, group control URLs, repeated-failure confirmation, switch thresholds and cooldowns. Stable connections use less frequent checks; speed measurements run separately, at most once every 30 minutes.
- **LuCI controls:** server health, group routes, manual exit selection, client logs, service controls and list updates. Long operations run in the background with serialization.
- **DNS and nftables:** IPv4/IPv6, DNS-based selective routing, exclusions, killswitch and DNS/DoH settings. Group route changes are atomic and preserve populated address sets.
- **Diagnostics:** configuration and domain checks, direct/tunnel external IP comparison, speed and latency measurements.
- **Persistent settings:** APK updates preserve the configuration; multi-server passwords are stored separately in owner-only files.

The generators and UCI configuration also support `itdoginfo/allow-domains` lists, custom domains and subnets. The current group settings UI uses Geosite.

## Installation

Requirements: **OpenWrt 25.12+**, LuCI, `apk`, SSH access and your TrustTunnel server configuration. Supported client architectures: `aarch64`/`arm64`, `armv7l`/`armv8l`, `mips`, `mipsel` and `x86_64`. The installer does not support OpenWrt releases using `opkg`.

Run on the router:

```sh
sh -c "$(wget -O - https://raw.githubusercontent.com/nekl3103/trusttunnel/main/install.sh)"
```

The installer downloads the **latest published package release** and the TrustTunnel client. Changes present only in `main` become available through this command after a new release is published.

Domain routing requires `dnsmasq-full` with `nftset`. The installer offers to replace stock `dnsmasq` if that support is missing; replacement restarts DNS. Configure servers and groups before starting the service after a fresh install.

## Configure in LuCI

1. Open **Services → TrustTunnel → Settings**.
2. In **Servers**, add a server, give it a name and click **Import…** in its form. Paste a configuration or `tt://` link, or enter connection settings manually. Add other servers as needed.
3. In **Site groups**, load the category catalog, select a category and add it. Examples: `youtube`, `telegram`, `openai`.
4. Choose a fixed server or automatic strategy for each group. Under **Options**, configure its pool, primary server, selection metric, control URL and additional domains.
5. Save and apply. Enable startup on boot under **General** if needed, then start the service on **Status**.
6. Check server health and selected group exits. Use **Diagnostics** to check a domain and external IP.

| Example group | Exit policy |
|---|---|
| YouTube | Automatic selection from two servers |
| Telegram | Fixed server |
| ChatGPT / OpenAI | Primary with fallback |

For device-specific routing, save the groups first, then add a device under **Devices**, enter its IP, subnet or MAC, and assign groups. Enable **Device routing** under **General** and apply.

## Routing modes

| Mode | Traffic through the VPN |
|---|---|
| Selective | Selected group domains and subnets, respecting exclusions and device rules |
| Full | LAN internet traffic, respecting configured exclusions |

Router-originated traffic is a separate option. When enabled, the killswitch blocks selected traffic if the tunnel is unavailable.

Domain matching relies on router DNS. Device-side DoH/DoT can bypass it, and sites sharing an IP can match the same rule. Geosite `regexp` and `keyword` rules are unsupported; the UI reports skipped rule counts. `full` rules use dnsmasq domain matching, which also includes subdomains.

Each enabled server starts a separate client and consumes memory. Add guest networks explicitly to the LAN interface list.

## Updates and documentation

Run the installer again to update the published package and client. It preserves settings and restores a previously running service.

- [Detailed guide](GUIDE.en.md): DNS, routing, diagnostics, updates and removal.
- [Installation on another router](INSTALL-OTHER-ROUTER.ru.md) (Russian).
- [UCI settings reference](SETTINGS.ru.md) (Russian).

The guides also describe the previous single-server interface. Follow the steps above for the current settings tabs.

## Tests and package builds

Run shell tests on Linux:

```sh
sh tests/run.sh
```

GitHub Actions checks tests, executable permissions, ShellCheck **0.11.0**, shell/JavaScript/JSON/ucode syntax and LuCI/ucode module imports. CI uses Ubuntu 24.04.

The **Release** workflow builds APKs using the OpenWrt SDK for `x86-64-25.12.5`. The LuCI package has architecture `all`; the VPN client binary is installed separately for the router CPU. The main package and Russian translation are uploaded as artifacts; pushing a `v*` tag also publishes them to GitHub Releases.

## License

[GPL-2.0](LICENSE). Uses [TrustTunnelClient](https://github.com/TrustTunnel/TrustTunnelClient), [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community) and [itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains). This is a community integration separate from the official AdGuard product.
