# 内容引擎媒体工具交付门禁

FFmpeg 和 ffprobe 不是本仓库 npm 或 Python 依赖的一部分。开发环境可以使用明确配置的本机工具；任何会复制媒体工具的内部评估包或交付包，都必须提供真实、按版本的来源和再分发记录。

构建时同时设置以下变量：

- `XIAOXI_MEDIA_TOOLS_ROOT`：媒体工具发行包的根目录；记录中的 `tool.sourceArtifactPath` 必须相对此目录，且其 SHA-256 必须与真实下载/发行文件一致。
- `XIAOXI_FFMPEG_PATH` 与 `XIAOXI_FFPROBE_PATH`：对应的两个可执行文件，必须与记录中的 `runtime.files` 一致。
- `XIAOXI_MEDIA_TOOLS_LICENSE_RECORD`：基于 `media-tools-license-record.template.json` 填写的外部记录。

记录必须列出实际要复制的运行时闭包（包括 DLL 或其他依赖）、每个文件的 SHA-256、许可证/NOTICE 文件、来源 URL、来源发行文件路径及哈希、条款 URL 和真实确认人。`tool.version` 必须逐字填写 `ffmpeg -version` 第一行的版本 token，且必须与 `ffprobe -show_program_version` 返回的 `program_version.version` 完全一致；不能只填主版本或部分版本。构建会在复制前后核对全部哈希、记录闭包与实际包的逐项对应关系，并以包内工具、隔离后的 DLL/PATH 环境执行真实的图像、音频和字幕滤镜烟测；记录不包含 API key、license key、token 或其他秘密。

`internal-evaluation` 只可用于已确认的内部评估再分发。商业交付必须使用 `commercial-delivery`，并提供商业再分发依据。空模板、仅在当前电脑 PATH 中可运行的工具、或无法证明来源/授权的工具都不能被打入用户应用。
