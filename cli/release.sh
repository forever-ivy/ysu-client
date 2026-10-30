#!/bin/sh
# 打包可下载的 ysu:单文件 ysu.mjs(Node>=20,不依赖 node_modules)+ 压缩包 + bun 独立可执行文件。产物在 cli/release/
set -e
cd "$(dirname "$0")/.."
V=$(sed -n 's/^export const CLI_VERSION = "\(.*\)"/\1/p' cli/main.ts)
OUT=cli/release; rm -rf "$OUT"; mkdir -p "$OUT"
YSU_CLI_RELEASE=1 YSU_CLI_OUTFILE="$OUT/ysu.mjs" node cli/build.mjs
P="ysu-cli-v$V"; D="$OUT/$P"; mkdir -p "$D/bin"
cp "$OUT/ysu.mjs" "$D/"
printf '#!/bin/sh\nD="$(cd "$(dirname "$0")/.." && pwd -P)"\nexec node "$D/ysu.mjs" "$@"\n' > "$D/bin/ysu"; chmod +x "$D/bin/ysu"
printf '@echo off\r\nnode "%%~dp0..\\ysu.mjs" %%*\r\n' > "$D/bin/ysu.cmd"
cp cli/release-README.md "$D/README.md"
(cd "$OUT" && tar czf "$P.tar.gz" "$P" && python3 -m zipfile -c "$P.zip" "$P")
for t in linux-x64 darwin-arm64 darwin-x64 windows-x64; do
  ext=""; [ "$t" = windows-x64 ] && ext=".exe"
  bun build --compile --target=bun-$t "$OUT/ysu.mjs" --outfile "$OUT/ysu-v$V-$t$ext" >/dev/null
done
rm -rf "$D"
(cd "$OUT" && sha256sum ysu.mjs *.tar.gz *.zip ysu-v* > SHA256SUMS)
ls -la "$OUT"
