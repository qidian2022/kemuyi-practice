# Supabase 账户与进度同步

前端继续使用 https://qidian2022.github.io/kemuyi-practice/ ，账户认证和进度存储使用科目一专用 Supabase 项目 `kemuyi-practice`（项目 ID：`tvkwiiqjjaoodeoxswoq`）。项目地址为 `https://tvkwiiqjjaoodeoxswoq.supabase.co`，进度保存在 `kemuyi_progress` 表。无需 Vercel 或其他应用服务器。

## 1. 配置科目一专用项目的注册设置

在 `kemuyi-practice` 项目 **Authentication → Sign In / Providers → Email** 中设置：

- 邮箱密码认证已启用。
- 允许新用户注册。
- **Confirm email 已关闭**，注册后直接返回登录会话。

本应用的界面只使用用户名和密码。用户名为 3–32 位字母、数字、下划线或短横线，不区分大小写；密码为 8–128 位。内部将规范化后的用户名一一映射为 `kemuyi.<用户名>@users.kemuyi-practice.invalid`，用独立命名空间连接 Supabase Auth。该内部地址不展示给用户，不用于发信。

程序会在注册前读取公开 Auth 设置；不满足直接注册条件时暂停注册，显示设置提示。应用不发送验证邮件，也没有邮件找回入口。账户未绑定实际邮箱，忘记密码后不能通过邮件找回。

账户、注册设置和进度表统一配置在科目一专用项目中。本文后续的数据库操作和公开密钥均来自该项目。

## 2. 创建科目一进度表

在 `kemuyi-practice` 项目的 **SQL Editor** 中，以项目数据库管理角色完整执行 [`supabase/001_progress.sql`](supabase/001_progress.sql)。脚本在事务中创建：

- `public.kemuyi_progress`：每个 Auth 用户一条进度记录。
- 本人可读的 RLS 策略。
- `public.kemuyi_save_progress`：校验调用者 ID、记录结构和云端版本后保存。

脚本可重复执行，保留已有科目一进度。它不改动其他应用表。匿名角色没有进度读写权限；登录用户不能直接 INSERT、UPDATE 或 DELETE 进度表，写入统一经过带版本检查的函数。

## 3. 配置 GitHub Pages

在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 中新增：

| 名称 | 值 |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://tvkwiiqjjaoodeoxswoq.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `kemuyi-practice` 项目的 public publishable key；也支持该项目的旧版 public anon key |

前端只能使用 publishable / anon 公开密钥。程序会拒绝 `service_role` 和 secret key。公开项目地址与公开密钥会进入网页构建结果，数据权限由 Auth、RLS 和数据库函数执行。

在 **Actions → Deploy to GitHub Pages → Run workflow** 重新构建，或推送到 `main` 触发部署。变量缺失或格式不正确时，页面保留游客练习并显示配置提示。

用户名密码流程不使用邮件回调，无需配置 Redirect URLs。

## 4. 导入 Chrome 原有记录

1. 使用原 Chrome 浏览器打开原站 `https://qidian2022.github.io/kemuyi-practice/`，核对原来的已练题数、答对题数和收藏数。
2. 点击“登录 / 注册”，输入自定义用户名和密码；注册成功后直接登录。
3. 打开“账户管理”，点击“导入游客记录”。首次导入空账户时保留原入口、题序、当前位置、答案与收藏；已有账户则合并答案与收藏，同题不同答案保留账户答案。
4. 等待状态变为“已同步”，再在另一设备登录同一用户名。另一设备只下载此账户的进度，不会自动导入其游客记录。

本机原有精选记录为 **255/300、答对 192、收藏 62** 时，导入后应在精选入口看到相同数据。游客原件和首次迁移前的原始备份保留，退出账户后仍可回到游客练习。

## 本地开发与测试

复制 `.env.example` 为 `.env.local`，填入同样的公开项目配置后运行：

```bash
npm ci
npm run dev
```

`.env.local` 不提交到 Git。连接真实项目的开发页面使用真实账户与数据；测试使用显式模拟配置或独立测试项目。

```bash
npm test
npm run build
```

测试不读取 `.env.local` 或真实浏览器记录。存储测试使用独立内存，SDK 认证和数据请求使用模拟 HTTP 响应。SQL 测试通过 PGlite 的 Postgres 引擎执行完整迁移，验证匿名拒绝访问、RLS 本人隔离、直接写入拒绝、ID 伪造拒绝、同版本两次保存仅一次成功、结构校验和重跑迁移保留既有表数据。

## 本机存档与同步规则

- 游客使用 `kemuyi-practice-v3`，首次迁移前的原始字符串保存在 `kemuyi-guest-original-v1`。账户使用 `kemuyi-account-progress-v1:<用户ID>`，彼此独立。
- 官方 Supabase SDK 管理令牌、自动刷新和会话存储。每个项目使用科目一专属存储前缀；会话保存在当前标签页的 `sessionStorage`，刷新可继续。不同标签页使用独立认证广播名称，各自登录的账户互不切换。仅包含用户ID与用户名的提示用于断网时恢复本机账户练习，云端仍以经过 Supabase 验证的身份为准。
- SDK 请求统一设置 20 秒超时，并保留调用者取消信号。退出使用 `signOut({ scope: 'local' })`，撤销当前会话的刷新能力并清除本机登录状态；已签发的访问 JWT 按 Supabase 的过期时间失效。账户练习缓存保留。
- 服务端保存函数要求参数用户ID等于 `auth.uid()`；即使账户在请求途中变化，也不能将旧账户记录写到新账户。
- 每次上传带已读取的云端版本。两台设备都有修改时暂停同步，保留双份快照并展示两边已练数量，可选择合并、使用云端或以本机覆盖云端。本机保留最近 5 份冲突备份。
- 合并保留两边的答案与收藏，同题不同答案保留本机答案。需要保留某台设备的“重新开始”结果时，选择以该设备的记录覆盖。
- 断网可继续本机练习，恢复连接后自动重试；上传过程中新增的答案在下一轮同步。同步状态、离线状态和冲突提示显示在练习页顶部。
- 下载、切换账户、退出、导入和冲突解决前检查未保存进度。保存失败时保留当前标签页，可重试保存或导出含内存答案的 JSON。已存在但无法解析的账户存档不会被空白记录覆盖。

## 参考

- [Supabase 邮箱密码认证与直接注册设置](https://supabase.com/docs/guides/auth/passwords)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Auth 地址格式检查源码](https://github.com/supabase/auth/blob/master/internal/api/mail.go)
- [Supabase Auth 自动确认后直接返回会话的源码](https://github.com/supabase/auth/blob/master/internal/api/signup.go)
