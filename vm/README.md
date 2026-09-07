# 部署到一台 VM（rootless podman + Caddy）

跟本機 `podman compose up` 用的是同一份 `Dockerfile`、同樣的 migrate / seed、同樣的 demo 腳本；差別全部收在這個資料夾：對外只開 Caddy 的 80 / 443、密碼從 `vm/.env` 讀、migrate / seed 在容器裡跑（VM 不裝 Bun）。根目錄的 `docker-compose.yml` 是本機用的，不動。

## VM 一次性準備（Debian 13，已測）

```bash
sudo apt-get update && sudo apt-get install -y git podman podman-compose
# rootless podman 預設不能綁 1024 以下的 port，Caddy 要 80 / 443
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-podman.conf && sudo sysctl --system >/dev/null
# rootless 容器掛在使用者 session 下；不開 linger 的話 SSH 斷線容器會跟著被收掉
sudo loginctl enable-linger "$USER"
# （可選）VM 重開機後把 restart: always 的容器拉起來
systemctl --user enable --now podman-restart.service
```

跑完 `exit` 重新連線一次，podman 的 systemd WARN 才會消失。

雲端這邊還要：防火牆開 **80 / 443**（GCP 是 VPC firewall rule，VM 裡設沒用）。domain 沒有的話用 nip.io：`任何字.<IP>.nip.io` 會解析到那個 IP，Let's Encrypt 照樣發憑證。

## 部署

```bash
git clone https://github.com/SeanChenR/edu-doc-ingest.git && cd edu-doc-ingest
cp vm/.env.example vm/.env
# 填 vm/.env：SITE_ADDRESS、三組密碼、兩把 seed key（openssl rand -hex 24）
vm/deploy.sh
```

`deploy.sh` 做的事：`git pull` → 拉基底 image → build → `up -d` → 等 db → 容器內 migrate + seed → 打 `/ready`。每步冪等，之後更新程式就再跑一次（`--no-build` 跳過 build）。

## 驗證

```bash
API_URL=https://doc-ingest.<IP>.nip.io API_KEY_ALPHA=<vm/.env 的 ALPHA> API_KEY_BETA=<BETA> scripts/curl-demo.sh
```

在你自己的電腦跑，12 步跟本機一樣。Swagger 在 `https://…/docs`。

## 日常

```bash
C="podman compose -f $PWD/vm/docker-compose.yml -p doc-ingest"   # 在 repo 根目錄；-f 要絕對路徑（podman-compose 會 chdir）
$C ps                         # 四個容器都要 healthy / running
$C logs -f api worker         # JSON log（LOG_PRETTY 預設 false）
$C exec db psql -U postgres doc_ingest   # 看資料；DB 沒開對外 port，只有這條路
$C down                       # 停（volume 保留）；down -v 連資料一起清
```

## 刻意不做的

不推 image 到 registry、不設 CI/CD、不加 rate limit、不做多台。單台 VM 給一個人驗收，這些是多的；正式環境怎麼補見根目錄 README §11。
