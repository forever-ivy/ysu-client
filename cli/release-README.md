# ysu — 燕山大学终端 CLI

## 运行方式(三选一)

1. **单文件**(需要 Node.js ≥ 20,无其它依赖):`node ysu.mjs --help`
2. **压缩包** `ysu-cli-v*.tar.gz` / `.zip`:解压后 `bin/ysu --help`(Windows: `bin\ysu.cmd --help`)
3. **独立可执行文件**(不需要 Node):`ysu-v*-linux-x64` / `-darwin-arm64` / `-darwin-x64` / `-windows-x64.exe`。
   Linux/macOS 先 `chmod +x`;macOS 首次运行可能需要 `xattr -d com.apple.quarantine <文件>`。

## 快速开始

```bash
ysu --help
ysu schema --json        # 全部命令与参数
```

有副作用的命令默认 dry-run,加 `--confirm` 才执行。状态保存在 `~/.config/ysu-cli`(或 `YSU_CLI_HOME`),发布包里不含任何账号数据。
