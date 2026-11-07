(() => {
  const U = window.UI;
  const demo = (label, message) => `<button type="button" class="text-action" data-demo="${message}">${label}</button>`;
  const grouped = (title, content) => U.section(title, `<div class="list">${content}</div>`);
  const sample = '【示例驿站】您的包裹已到青禾小区东门驿站，取件码 6-1832，请及时领取。';
  const scenes = [
    {
      id: 'my', title: '我的', group: '设置', route: '/pages/my/index', tab: 'my',
      description: '设置首页。识别统计保持本机口径，常用配置按职责归组。',
      content: () => `<div class="stack">
        <div class="card inset"><div class="hrow between"><div><p class="muted small">累计识别</p><strong class="mini-code">128</strong></div><div><p class="muted small">累计取走</p><strong class="mini-code">116</strong></div>${U.badge('本机记录')}</div></div>
        ${grouped('连接与运行', U.row('线上账号', '家人和平台账号', '3 个账号', 'accounts') + U.row('扫描与权限', '最近扫描 09:42', U.badge('正常', 'teal'), 'scan') + U.row('桌面卡片', '尺寸与隐私显示', '', 'widgets'))}
        ${grouped('识别与优化', U.row('识别优化', '短信建议、站点增强与人工修正', U.badge('2 条待核对', 'blue'), 'automation') + U.row('短信识别规则', '本机取件码与提醒模板', '8 条', 'sms-rules') + U.row('物流识别规则', '本机到站与站点位置', '6 条', 'logistics-rules'))}
        ${grouped('帮助与应用', U.row('常见问题', '', '', 'faq') + U.row('关于应用', '许可与更新记录', '', 'about') + U.row('检查更新', '', 'v3.1.33', 'update'))}
      </div>`
    },
    {
      id: 'accounts', title: '线上账号', group: '设置', route: '/pages/my/online-accounts', back: 'my',
      description: '已绑定状态。全局同步只保留一个主入口，账号行保留各自的登录与采集情况。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>家庭取件服务</strong>${U.badge('已连接', 'teal')}</div><p class="muted small">最近同步 09:40 · 2 个操作待同步</p>${U.button('立即同步', '', 'primary')}</div>
        ${grouped('已授权账号', U.row('淘宝 · 日常账号', '我 · 最近采集 09:39', U.badge('正常', 'teal')) + U.row('京东 · 家庭账号', '妈妈 · 最近采集 09:38', U.badge('正常', 'teal')) + U.row('拼多多 · 生活账号', '我 · 需要更新登录', U.badge('已失效', 'amber'), 'accounts-error'))}
        ${grouped('设备绑定', U.kv('服务地址', 'https://parcel-demo.example') + U.kv('更新方式', '后台定时采集，打开应用读取快照') + U.row('更换绑定服务', '本机历史记录保留', '', 'accounts-unbound'))}
        <div class="card inset stack gap-sm">${demo('管理后台账号', 'Android 安装版会确认并复制后台地址，再由浏览器管理登录。')}${demo('解除设备绑定', '解除前确认：停止本设备线上同步，本地历史仍保留。')}</div>
      </div>`
    },
    {
      id: 'accounts-unbound', title: '绑定服务', group: '设置', route: '/pages/my/online-accounts', back: 'accounts',
      description: '未绑定/更换服务表单；扫码、相册和粘贴均只填入待核验信息。',
      content: () => `<div class="stack">
        ${U.note('本地取件记录仍可使用。绑定后同步已授权的家人和平台账号。')}
        <div class="card inset stack"><div class="hrow">${U.button('扫描授权码', '', 'secondary')}${U.button('识别图片', '', 'secondary')}</div>${U.button('粘贴授权信息', '', 'secondary')}<details><summary class="text-action">手动粘贴或修改识别内容</summary><div class="field"><label for="pairing-text">授权信息</label><textarea id="pairing-text" rows="3" placeholder="二维码原文、服务地址或文字授权码"></textarea></div></details></div>
        <div class="card inset stack">${U.field('服务地址', 'https://parcel-demo.example', '请输入 HTTPS 服务地址', 'url')}${U.field('一次性授权码', 'DEMO-7K4M', '输入后台生成的授权码')}<p class="small muted">授权码 10 分钟内有效。下一步先核验服务与授权范围。</p></div>
      </div>`,
      footer: () => U.button('核验授权范围', 'accounts-verify')
    },
    {
      id: 'accounts-verify', title: '确认授权范围', group: '设置', route: '/pages/my/online-accounts · pairingPreview', back: 'accounts-unbound',
      description: '核验完成后才允许绑定。家人整组授权与指定账号授权分开列明。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>家庭取件服务</strong>${U.badge('已核验', 'teal')}</div><p class="small muted">https://parcel-demo.example</p>${U.kv('授权有效至', '今天 10:10')}</div>
        ${grouped('家人整组授权', U.row('妈妈', '当前 1 个平台账号', U.badge('包含以后新增', 'blue')))}
        ${grouped('指定账号授权', U.row('淘宝 · 日常账号', '我', U.badge('仅此账号')) + U.row('拼多多 · 生活账号', '我', U.badge('仅此账号')))}
        ${U.note('指定账号不会自动扩大为家人整组授权。更换服务后，本地历史记录保留。')}
      </div>`,
      footer: () => `<div class="hrow">${U.button('返回修改', 'accounts-unbound', 'secondary')}${U.button('确认绑定', 'accounts')}</div>`
    },
    {
      id: 'accounts-error', title: '账号需要处理', group: '设置', route: '/pages/my/online-accounts · error', back: 'accounts',
      description: '平台登录失效与设备授权失效分开；现存本地记录不隐藏。',
      content: () => `<div class="stack">
        ${U.note('拼多多登录已失效，设备绑定仍然有效。', 'amber')}
        <div class="card inset stack"><div class="hrow between"><strong>生活账号</strong>${U.badge('需要重新登录', 'amber')}</div>${U.kv('所属家人', '我')}${U.kv('最近成功采集', '昨天 18:20')}<p class="muted small">请在后台更新这个平台的登录，再返回同步。</p>${U.button('前往后台更新', '', 'primary')}</div>
        ${grouped('仍可使用', U.row('本地取件和历史记录', '连接恢复后继续同步', U.badge('已保留', 'teal')))}
        <details class="card inset"><summary class="text-action">如果是设备授权失效</summary><p class="small muted">重新获取后台授权码，核验后绑定。本地历史不会清除。</p>${U.link('重新绑定服务', 'accounts-unbound')}</details>
      </div>`,
      footer: () => U.button('重新同步', 'accounts', 'secondary')
    },
    {
      id: 'automation', title: '识别优化', group: '识别与优化', route: '/pages/my/auto-settings + /pages/my/match-rules', back: 'my',
      description: '设计建议的集中入口，原有开关和数据来源不变；三个优化流程保持独立。',
      content: () => `<div class="stack">
        <div class="card inset"><div class="hrow between"><strong>后台 AI 服务</strong>${U.badge('可用', 'teal')}</div><p class="muted small">家庭服务默认渠道 · 跟随后台设置</p></div>
        ${grouped('待核对', U.row('短信识别建议', '核对样例后保存到本机规则', U.badge('1 条', 'blue'), 'sms-ai') + U.row('人工修正记录', '查看提交进度与处理回执', U.badge('1 条待核对', 'amber'), 'corrections'))}
        ${grouped('自动处理', U.row('领取语句监测', '后台已开启 · 仅明确领取才自动完成', U.badge('已开启', 'teal'), 'auto-completions') + U.kv('AI 监测词调优', U.badge('已开启', 'blue')) + U.row('优化设置', '站点片段与人工修正样本', '', 'optimization'))}
        ${grouped('本机规则', U.row('短信识别规则', '取件码与到站、催取提醒', '8 条', 'sms-rules') + U.row('物流识别规则', '到站事件与站点位置', '6 条', 'logistics-rules'))}
      </div>`
    },
    {
      id: 'optimization', title: '优化设置', group: '识别与优化', route: '/pages/my/auto-settings · stationEnhancement / manualLearning', back: 'automation',
      description: '手机采集许可和后台处理职责分开，不增加渠道、密钥或自动批准设置。',
      content: () => `<div class="stack">
        ${grouped('站点片段', U.toggle('提交未识别站名', '脱敏后提交已绑定后台整理', true) + U.kv('提交状态', '2 条待上传') + U.kv('最近提交', '今天 09:40'))}
        ${U.note('只提交站名片段。姓名、电话、单号、取件码与短信正文不上传；建议在后台核对后加入规则。')}
        ${grouped('人工修正', U.toggle('提交修正样本', '手动匹配或更换站点后保存脱敏样本', true) + U.row('查看修正记录', '本地保存、后台处理、手机接收', '', 'corrections'))}
        ${U.note('关闭后停止采集和提交新样本，相关撤回仍会同步。')}
        ${grouped('后台服务', U.row('家庭服务默认渠道', '服务设置在后台统一管理', U.badge('可用', 'teal')) + U.row('线上账号与设备绑定', '', '', 'accounts'))}
      </div>`
    },
    {
      id: 'scan', title: '扫描与权限', group: '设置', route: '/pages/my/auto-settings · scan / permission', back: 'my',
      description: '将扫描频率、权限、后台限制和手动扫描放在同一页；没有准点保证。',
      content: () => `<div class="stack">
        ${grouped('短信识别', U.toggle('定时识别短信', '由 Android 系统安排执行', true) + U.kv('扫描频率', '约每 1 小时') + U.kv('最近实际扫描', '今天 09:42'))}
        ${grouped('运行条件', U.row('读取短信', '已允许', U.badge('正常', 'teal')) + U.row('后台运行', '未受省电限制', U.badge('正常', 'teal')))}
        <div class="card inset stack gap-sm">${demo('应用权限设置', '请在 Android 系统设置中允许读取短信；部分手机另有通知类短信权限。')}${demo('后台运行设置', '打开 Android 后台运行设置。系统休眠或强制停止仍可能延迟扫描。')}</div>
        ${U.note('本次新增 2 个取件码、1 条提醒。', 'teal')}
      </div>`,
      footer: () => U.button('立即扫描', '', 'primary')
    },
    {
      id: 'scan-denied', title: '需要短信权限', group: '设置', route: '/pages/my/auto-settings · smsPermission=false', back: 'scan',
      description: '权限拒绝状态。显示真实阻断原因，保留本地记录与打开系统设置入口。',
      content: () => `<div class="stack">
        ${U.note('未获得短信权限，定时识别尚未开启。', 'amber')}
        ${grouped('短信识别', U.kv('读取短信', U.badge('未允许', 'amber')) + U.kv('定时识别', '未开启') + U.kv('最近实际扫描', '昨天 18:42'))}
        <div class="card inset stack gap-sm"><strong>允许读取短信</strong><p class="small muted">在应用权限设置中允许读取短信。部分手机还需要允许“通知类短信”。</p>${U.button('打开应用权限设置', '', 'primary')}</div>
        ${grouped('本地记录', U.kv('取件码与历史', '已保留') + U.row('线上账号', '线上订单可继续同步', '', 'accounts'))}
      </div>`
    },
    {
      id: 'widgets', title: '桌面卡片', group: '设置', route: '/pages/my/auto-settings · widget=list', back: 'my',
      description: '默认 4×2 列表卡片；三个尺寸有独立可切换场景，保留隐私与添加入口。',
      content: () => `<div class="stack">
        ${U.segmented([['2 × 2', 'widgets-small'], ['4 × 2', 'widgets'], ['5 × 3', 'widgets-large']], 1)}
        <div class="card inset stack"><div class="hrow between"><strong>取件列表</strong>${U.badge('3 件待取', 'blue')}</div><div class="stack gap-sm"><div class="hrow between"><div class="hrow"><span class="hero-cabinet">6 柜</span><strong class="mini-code">6-1832</strong></div>${demo('取件', '在桌面卡片标记本件已取；此处为设计预览。')}</div><p class="small muted">青禾小区东门驿站 · 我</p></div><div class="divider"></div><div class="stack gap-sm"><div class="hrow between"><div class="hrow"><span class="hero-cabinet">2 柜</span><strong class="mini-code">2-0417</strong></div>${demo('查看', '共码 2 件，进入取件详情选择本次领取的包裹。')}</div><p class="small muted">云杉便利店 · 妈妈 · 共码 2 件</p></div><div class="hrow between"><span class="small muted">09:42 更新</span>${demo('刷新', '刷新桌面卡片数据。')}</div></div>
        ${grouped('隐私显示', U.toggle('显示取件信息', '取件码、柜号、公司与地址', true) + U.row('隐私模式预览', '', '', 'widgets-privacy'))}
      </div>`,
      footer: () => U.button('添加到桌面', '', 'primary')
    },
    {
      id: 'widgets-small', title: '紧凑桌面卡片', group: '设置', route: '/pages/my/auto-settings · widget=small', back: 'my',
      description: '2×2 紧凑卡片，突出一个取件码与剩余数量。',
      content: () => `<div class="stack">
        ${U.segmented([['2 × 2', 'widgets-small'], ['4 × 2', 'widgets'], ['5 × 3', 'widgets-large']], 0)}
        <div class="card inset stack"><div class="hrow between"><strong>取件列表</strong>${U.badge('3 件待取', 'blue')}</div><span class="small muted">11 月 7 日</span><div class="hrow"><span class="hero-cabinet">6 号柜</span><span class="small muted">我</span></div><strong class="code-hero">6-1832</strong><p class="small muted">青禾小区东门驿站</p>${U.button('取件', '', 'secondary')}<div class="divider"></div><div class="hrow between"><span class="small muted">还有 1 个取件码</span>${demo('刷新', '刷新桌面卡片数据。')}</div></div>
        ${grouped('隐私显示', U.toggle('显示取件信息', '取件码、柜号、公司与地址', true) + U.row('隐私模式预览', '', '', 'widgets-privacy'))}
      </div>`,
      footer: () => U.button('添加到桌面', '', 'primary')
    },
    {
      id: 'widgets-large', title: '大号桌面卡片', group: '设置', route: '/pages/my/auto-settings · widget=large', back: 'my',
      description: '5×3 大卡片，保留站点/平台筛选、共码多件、待确认收到与代收包裹。',
      content: () => `<div class="stack">
        ${U.segmented([['2 × 2', 'widgets-small'], ['4 × 2', 'widgets'], ['5 × 3', 'widgets-large']], 2)}
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>待取与收货</strong>${demo('全部站点⌄', '选择站点：全部站点、青禾小区东门驿站、云杉便利店。')}</div><div class="hrow between"><div class="stack gap-sm"><div class="hrow"><span class="hero-cabinet">6 柜</span><strong class="mini-code">6-1832</strong></div><span class="small muted">青禾小区东门驿站 · 我</span></div>${demo('取件', '标记本件已取。')}</div><div class="divider"></div><div class="hrow between"><div class="stack gap-sm"><strong class="mini-code">2-0417</strong><span class="small muted">云杉便利店 · 妈妈 · 共码 2 件</span></div>${demo('查看', '共码 2 件，进入详情选择领取。')}</div><div class="divider"></div><div class="hrow between"><div class="stack gap-sm"><strong>日用收纳袋</strong><span class="small muted">已送达 · 待确认</span></div>${demo('确认收到', '按运单确认收到，七秒内可撤销。')}</div><div class="divider"></div><strong>代收包裹 · 3</strong>${U.segmented([['全部', 'widgets-large'], ['淘宝 2', ''], ['京东 1', '']], 0)}${U.kv('棉质收纳套装', '妈妈 · 运输中')}${U.kv('简约桌面灯', '我 · 待发货')}<div class="hrow between"><span class="small muted">09:42 更新</span>${demo('刷新', '刷新桌面卡片数据。')}</div></div>
        ${grouped('隐私显示', U.toggle('显示取件信息', '取件码、柜号、公司与地址', true) + U.row('隐私模式预览', '', '', 'widgets-privacy'))}
      </div>`,
      footer: () => U.button('添加到桌面', '', 'primary')
    },
    {
      id: 'widgets-privacy', title: '桌面卡片隐私', group: '设置', route: '/pages/my/auto-settings · widgetPrivacy', back: 'widgets',
      description: '隐私模式同时隐藏码、柜号、公司、地址及相关详情，保留进入应用的入口。',
      content: () => `<div class="stack">
        ${grouped('隐私显示', U.toggle('显示取件信息', '关闭后在桌面隐藏敏感内容', false))}
        <div class="card inset stack"><div class="hrow between"><strong>待取与收货</strong>${U.badge('3 件待取')}</div><strong class="code-hero">••••••</strong><p class="muted">隐私模式 · 打开查看</p><div class="divider"></div><strong class="code-hero">••••••</strong><p class="muted">隐私模式 · 打开查看</p><div class="divider"></div><div class="hrow between"><strong>代收包裹</strong><span class="muted">••</span></div><p class="muted small">详情已隐藏</p></div>
        ${U.note('如果当前桌面不支持直接添加，请在系统小组件列表选择“取件列表”。')}
      </div>`,
      footer: () => U.button('返回卡片预览', 'widgets', 'secondary')
    },
    {
      id: 'corrections', title: '人工修正记录', group: '识别与优化', route: '/pages/my/auto-settings · matchingFeedback / corrections', back: 'automation',
      description: '本地纠错为主线，提交回执附在事件上，避免把同一次纠错重复列成两张卡。',
      content: () => `<div class="stack">
        <div class="chips">${U.badge('待提交 1', 'blue')}${U.badge('待核对 1', 'amber')}${U.badge('失败 1', 'red')}</div>
        ${grouped('今天', U.row('更换取件站点', '云杉店 → 云杉便利店 · 09:35', U.badge('规则已应用', 'teal'), 'correction-detail') + U.row('更换取件站点', '青禾小区东门驿站 · 09:28', U.badge('提交失败', 'red'), 'correction-failed') + U.row('人工匹配包裹', '棉质收纳套装 · 09:20', U.badge('待核对', 'amber')) + U.row('更换取件站点', '青禾小区东门驿站 · 09:12', U.badge('待提交', 'blue')))}
        ${grouped('更早', U.row('恢复自动站点', '相关样本已同步撤回 · 昨天', U.badge('已撤回')) + U.row('人工匹配包裹', '当时未绑定后台，仅保存本机 · 昨天', U.badge('未提交')))}
        ${U.note('规则已应用表示收到处理结果，不代表识别效果已验证。')}
      </div>`
    },
    {
      id: 'correction-detail', title: '本次修正', group: '识别与优化', route: '/pages/my/auto-settings?correctionId=demo-correction', back: 'corrections',
      description: '纠错深链直接定位同一个事件。展示本地保存、后台结果与手机回执，不编造 AI 推理过程。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>更换取件站点</strong>${U.badge('本机已保存', 'teal')}</div>${U.kv('修正前', '云杉店')}${U.kv('修正后', '云杉便利店')}${U.kv('操作时间', '今天 09:35')}</div>
        ${U.section('提交进度', `<div class="card inset">${U.timeline([{ time: '09:35', text: '保存本地修正与脱敏样本' }, { time: '09:40', text: '后台已接收' }, { time: '09:41', text: '规则已应用 · 版本 24' }, { time: '09:42', text: '手机已保存规则，后台收到导入回执', active: true }])}</div>`)}
        ${U.note('后续新样本仍需验证识别效果。', 'blue')}
        ${grouped('提交详情', U.kv('提交尝试', '1 次') + U.kv('最近尝试', '今天 09:40') + U.kv('提交内容', '脱敏站名关系，不含原短信'))}
      </div>`
    },
    {
      id: 'correction-failed', title: '修正提交失败', group: '识别与优化', route: '/pages/my/auto-settings · matchingFeedback.failed', back: 'corrections',
      description: '失败样例保留本机修正，显示原始失败回执与尝试时间；通过现有同步流程重试。',
      content: () => `<div class="stack">
        ${U.note('连接后台超时，样本尚未获确认。', 'red')}
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>更换取件站点</strong>${U.badge('本机已保存', 'teal')}</div>${U.kv('修正前', '青禾东门')}${U.kv('修正后', '青禾小区东门驿站')}${U.kv('操作时间', '今天 09:28')}</div>
        ${grouped('提交状态', U.kv('处理结果', U.badge('失败，可重试', 'red')) + U.kv('提交尝试', '2 次') + U.kv('最近尝试', '今天 09:40') + U.kv('手机规则导入', '尚无回执'))}
        ${U.note('本机修正仍然有效。恢复连接后重新同步，继续提交此样本。')}
        <div class="list">${U.row('线上账号', '检查服务连接', '', 'accounts')}</div>
      </div>`,
      footer: () => U.button('重新同步', '', 'primary')
    },
    {
      id: 'auto-completions', title: '自动取件记录', group: '识别与优化', route: '/pages/my/auto-settings · recentCompletionResults', back: 'automation',
      description: '自动完成结果记录，非 AI 通用运行日志。监测开关只读后台状态。',
      content: () => `<div class="stack">
        ${grouped('后台状态', U.kv('领取语句监测', '已开启') + U.kv('AI 监测词调优', '已开启 · 服务可用'))}
        ${U.note('仅本人或收件人明确领取才会自动完成。代收、门口放置和泛签收不计入。')}
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>简约棉麻围裙</strong>${U.badge('自动完成', 'teal')}</div><p class="small muted">今天 08:56 · 我 · 淘宝</p>${U.kv('领取证据', '收件人本人已取件')}${U.button('查看包裹', '', 'secondary')}</div>
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>玻璃保鲜盒套装</strong>${U.badge('自动完成', 'teal')}</div><p class="small muted">昨天 18:34 · 妈妈 · 京东</p>${U.kv('领取证据', '本人自提完成')}${U.button('查看包裹', '', 'secondary')}</div>
        <p class="muted small">可在对应包裹撤销自动完成，或恢复自动判断。</p>
      </div>`
    },
    {
      id: 'sms-rules', title: '短信识别规则', group: '识别与优化', route: '/pages/my/match-rules', back: 'automation',
      description: '规则列表专注规则维护，AI 建议与忽略短信保留明确入口。',
      top: [{ icon: 'plus', label: '添加规则', target: 'sms-edit' }],
      content: () => `<div class="stack">
        <div class="list">${U.row('AI 识别建议', '1 条待核对 · 1 条需重试', U.badge('查看', 'blue'), 'sms-ai')}</div>
        <div class="card inset stack gap-sm">${U.toggle('通用取件短信', '内置 · 提取取件码、公司、地址', true)}<div class="hrow">${U.link('编辑规则', 'sms-edit')}${demo('删除规则', '删除前确认：不再识别新短信，已有取件记录保留。')}</div></div>
        <div class="card inset stack gap-sm">${U.toggle('示例驿站', '手动添加 · 11 月 6 日', true)}<div class="hrow">${U.link('编辑规则', 'sms-edit')}${demo('删除规则', '删除前确认：不再识别新短信，已有取件记录保留。')}</div></div>
        <div class="card inset stack gap-sm">${U.toggle('到站提醒', '内置 · 不提取取件码', true)}${U.link('编辑提醒模板', 'sms-edit')}</div>
        ${grouped('其他', U.row('使用预制规则', '先核对样例再保存', '', 'sms-presets') + U.row('已忽略短信', '可按当前规则恢复识别', '3 条', 'ignored'))}
      </div>`,
      footer: () => U.button('添加规则', 'sms-edit')
    },
    {
      id: 'sms-edit', title: '编辑短信规则', group: '识别与优化', route: '/pages/my/match-settings?mode=edit&id=demo-rule', back: 'sms-rules',
      description: '保留样例、正确码、起止文字与验证门槛；新增、预制和提醒模板复用此结构。',
      content: () => `<div class="stack">
        <div class="card inset stack">${U.field('规则名称', '示例驿站', '必填')}<div class="field"><label for="sms-sample">完整短信样例</label><textarea id="sms-sample" rows="4" maxlength="4000">${sample}</textarea></div>${U.field('正确取件码', '6-1832', '先核对这条短信中的取件码')}</div>
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>后台 AI 服务</strong>${U.badge('可用', 'teal')}</div><p class="muted small">只发送合成模板片段，原短信与真实码留在本机。</p>${U.button('生成并验证模板', '', 'secondary')}</div>
        ${U.section('提取位置', `<div class="card inset stack">${U.field('取件码 · 起始文字', '取件码')}${U.field('取件码 · 结束文字', '，')}${U.field('快递名称 · 起始文字', '【')}${U.field('快递名称 · 结束文字', '】')}${U.field('地址 · 起始文字', '已到')}${U.field('地址 · 结束文字', '，取件码')}</div>`)}
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>样例验证</strong>${U.badge('通过', 'teal')}</div>${U.kv('取件码', '6-1832')}${U.kv('快递名称', '示例驿站')}${U.kv('地址', '青禾小区东门驿站')}<p class="muted small">签名：示例驿站 · 必须包含：取件码</p></div>
        <details class="card inset"><summary class="text-action">验证说明</summary><p class="small muted">结束文字留空：取件码读取下一个完整码，其他字段读取至短信结尾。样例或正确码变更后，AI 候选需重新生成；不通过时展示原因并保留原规则。到站与催取模板不要求正确取件码，也不生成取件码。</p></details>
      </div>`,
      footer: () => U.button('保存规则', '', 'primary')
    },
    {
      id: 'sms-ai', title: '短信 AI 建议', group: '识别与优化', route: '/pages/my/match-rules · AiOptimizationPanel', back: 'automation',
      description: '自动准备候选建议；确认使用才生效，不展示虚构准确率或运行日志。',
      content: () => `<div class="stack">
        ${grouped('自动准备', U.toggle('准备优化建议', '扫描发现合适样例时自动分析', true) + U.kv('后台统一服务', '家庭服务默认渠道'))}
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>示例驿站取件短信</strong>${U.badge('待确认', 'blue')}</div><strong class="mini-code">6-1832</strong><p class="muted small">已通过本机样例与验证码反例校验。</p>${U.button('核对样例与规则', 'sms-ai-detail', 'secondary')}</div>
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>新的取件短信</strong>${U.badge('需重试', 'amber')}</div><p class="small muted">未通过本机样例校验，尚未保存规则。</p><div class="hrow">${demo('重试未完成', '重新分析未完成建议。失败原因保留，现有规则继续有效。')}${demo('忽略建议', '忽略本条候选建议，不修改原短信。')}</div></div>
        ${grouped('等待处理', U.row('待分析样例', '', U.badge('等待分析')) + U.row('正在准备候选', '', U.badge('分析中', 'blue')))}
        ${U.note('原短信与真实取件码留在本机。建议确认后才生效。')}
        ${demo('刷新服务状态', '重新读取已绑定后台的 AI 服务状态。')}
      </div>`
    },
    {
      id: 'sms-ai-unavailable', title: 'AI 服务暂不可用', group: '识别与优化', route: '/components/AiOptimizationPanel.vue · service.available=false', back: 'sms-ai',
      description: 'AI 默认服务未配置状态，不禁用本机手动规则。完整 AI 运行日志仍需后台能力支持。',
      content: () => `<div class="stack">
        ${U.note('请在后台 AI 设置中选择可用的默认服务。', 'amber')}
        ${grouped('服务状态', U.kv('后台统一 AI 服务', U.badge('未配置', 'amber')) + U.kv('自动准备建议', '暂不可开启') + U.kv('已保存的本机规则', '继续有效'))}
        <div class="card inset stack gap-sm"><strong>仍可手动识别</strong><p class="small muted">粘贴短信样例，设置提取文字并验证后保存。</p>${U.button('手动添加规则', 'sms-edit', 'secondary')}</div>
        <div class="list">${U.row('线上账号', '查看已绑定服务', '', 'accounts')}</div>
      </div>`,
      footer: () => U.button('刷新服务状态', '', 'primary')
    },
    {
      id: 'sms-ai-detail', title: '核对识别建议', group: '识别与优化', route: '/components/AiOptimizationPanel.vue · proposalDetails', back: 'sms-ai', sheet: true,
      description: '候选建议核对弹层，保留本机原样例与具体提取位置。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>建议提取的取件码</strong>${U.badge('待确认', 'blue')}</div><strong class="code-hero">6-1832</strong></div>
        ${U.section('本机短信样例', `<p class="inset">${sample}</p>`)}
        ${grouped('候选规则', U.kv('名称', '示例驿站取件短信') + U.kv('适用签名', '示例驿站') + U.kv('提取位置', '取件码 → ，') + U.kv('必要文字', '取件码'))}
        ${U.note('已通过样例与验证码反例校验。确认后保存本机规则。', 'teal')}
      </div>`,
      footer: () => `<div class="hrow">${U.button('忽略', 'sms-ai', 'secondary')}${U.button('确认使用', 'sms-rules')}</div>`
    },
    {
      id: 'sms-presets', title: '选择预制规则', group: '识别与优化', route: '/pages/my/match-rules · presetPopup', back: 'sms-rules', sheet: true,
      description: '选择仅进入编辑核对，不直接覆盖现有规则。',
      content: () => `<div class="stack">${U.note('选择后核对样例，再保存到本机规则。')}${grouped('取件短信', U.row('通用取件模板', '适用常见取件码语句', '', 'sms-edit') + U.row('示例驿站模板', '适用指定短信签名', '', 'sms-edit'))}${grouped('提醒短信', U.row('到站通知', '仅提醒，不提取取件码', '', 'sms-edit') + U.row('催取提醒', '仅提醒，不创建新取件码', '', 'sms-edit'))}</div>`
    },
    {
      id: 'logistics-rules', title: '物流识别规则', group: '识别与优化', route: '/pages/my/logistics-rules', back: 'automation',
      description: '本机规则与后台规则明确分开；列表保留启停、编辑、删除、恢复默认。',
      content: () => `<div class="stack">
        ${U.note('仅本机生效，不会上传或修改后台物流规则。')}
        <div class="card inset stack gap-sm">${U.toggle('已暂存至站点', '到站事件 · 内置规则', true)}<div class="hrow">${U.link('编辑规则', 'logistics-edit')}${demo('删除规则', '删除前确认：本机不再使用这条规则识别物流。')}</div></div>
        <div class="card inset stack gap-sm">${U.toggle('包裹已到', '到站事件 · 手动添加', true)}<div class="hrow">${U.link('编辑规则', 'logistics-edit')}${demo('删除规则', '删除前确认：本机不再使用这条规则识别物流。')}</div></div>
        <div class="card inset stack gap-sm">${U.toggle('站点位置提示', '仅站点位置 · 内置规则', false)}${U.link('编辑规则', 'logistics-edit')}</div>
        ${U.note('预计、未到达、退回、中转和催取提醒，不会被当作新的到站事件。')}
        ${demo('恢复默认规则', '恢复前确认：本机手动添加的物流规则将被删除。')}
      </div>`,
      footer: () => U.button('添加规则', 'logistics-edit')
    },
    {
      id: 'logistics-edit', title: '编辑物流规则', group: '识别与优化', route: '/pages/my/logistics-rules · editor', back: 'logistics-rules',
      description: '两种规则类型可见；多条起始文字和关键词保持各自独立输入。',
      content: () => `<div class="stack">
        <div class="card inset stack">${U.field('规则名称', '已暂存至站点')}<fieldset class="stack gap-sm"><legend class="small strong">规则类型</legend><label class="hrow"><input type="radio" name="logistics-kind" value="arrival" checked>到站事件</label><label class="hrow"><input type="radio" name="logistics-kind" value="location">仅站点位置</label></fieldset><div class="field"><label for="logistics-starts">起始文字 · 每行一种</label><textarea id="logistics-starts" rows="3">已暂存至\n包裹已到</textarea></div><div class="field"><label for="logistics-keywords">全部包含关键词 · 可选</label><textarea id="logistics-keywords" rows="2" placeholder="每行一个关键词"></textarea></div>${U.field('结束文字 · 可留空', '，请及时取件')}</div>
        <div class="card inset stack"><h2 class="section-title">样例测试</h2><div class="field"><label for="logistics-sample">物流文本</label><textarea id="logistics-sample" rows="3">包裹已到青禾小区东门驿站，请及时取件。</textarea></div>${U.field('预期站名 · 可选', '青禾小区东门驿站')}${U.button('测试当前规则', '', 'secondary')}${U.note('测试通过：青禾小区东门驿站 · 到站事件', 'teal')}</div>
      </div>`,
      footer: () => U.button('保存规则', '', 'primary')
    },
    {
      id: 'ignored', title: '已忽略短信', group: '识别与优化', route: '/pages/my/ignored', back: 'sms-rules',
      description: '保留原短信核对与逐条恢复，恢复按当前规则重新处理。',
      content: () => `<div class="stack">
        ${U.note('已忽略短信不会再次自动生成取件码。')}
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>示例驿站</strong><span class="small muted">今天 08:20</span></div><p>【示例驿站】请及时领取您寄存的包裹，详情请查看原通知。</p><p class="muted small">忽略原因：不是新的取件通知</p>${U.button('恢复识别', '', 'secondary')}</div>
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>服务通知</strong><span class="small muted">昨天 16:40</span></div><p>【服务通知】您的预约编号为 71428，可在服务页面查看进度。</p><p class="muted small">忽略原因：误识别为取件码</p>${U.button('恢复识别', '', 'secondary')}</div>
        <p class="small muted">恢复后按当前规则重新识别，不直接恢复旧的错误结果。</p>
      </div>`
    },
    {
      id: 'faq', title: '常见问题', group: '帮助', route: '/pages/my/faq', back: 'my',
      description: '按常见故障折叠，移除旧 DeepSeek/原样例上传文案，保留设置直达。',
      content: () => `<div class="stack">
        <details class="card inset" open><summary class="strong">为什么没有识别到取件码？</summary><p class="small muted">先确认短信权限与本机规则。某些手机需要额外允许“通知类短信”。没有取件码的到站或催取短信只会作为提醒。</p><div class="hrow">${U.link('扫描与权限', 'scan')}${U.link('短信识别规则', 'sms-rules')}</div></details>
        <details class="card inset"><summary class="strong">后台扫描为什么没有准点执行？</summary><p class="small muted">系统约每小时安排扫描，休眠、省电或强制停止可能延迟。可查看最近实际扫描时间，也可立即扫描。</p>${U.link('扫描与权限', 'scan')}</details>
        <details class="card inset"><summary class="strong">短信会上传吗？</summary><p class="small muted">日常识别在本机完成。AI 模板建议只发送合成模板片段，原短信和真实取件码留在本机。可选站点优化只提交脱敏片段或关系。</p>${U.link('优化设置', 'optimization')}</details>
        <details class="card inset"><summary class="strong">识别错了怎么办？</summary><p class="small muted">可以修改取件记录或忽略来源短信。人工修正和已取状态不会被再次扫描覆盖；已忽略短信可恢复识别。</p>${U.link('已忽略短信', 'ignored')}</details>
        <details class="card inset"><summary class="strong">快递公司或地址没有识别完整？</summary><p class="small muted">在规则编辑页检查字段的起始与结束文字，并用完整短信核对样例结果。不同格式可以保存不同规则。</p>${U.link('短信识别规则', 'sms-rules')}</details>
        <details class="card inset"><summary class="strong">线上账号失效会丢记录吗？</summary><p class="small muted">本地历史继续可用。平台账号登录在后台更新，设备授权失效则需要重新核验绑定。</p>${U.link('线上账号', 'accounts')}</details>
      </div>`
    },
    {
      id: 'about', title: '关于应用', group: '帮助', route: '/pages/my/about', back: 'my',
      description: '简化功能宣传，保留本地识别、私人版、许可、版本与历史入口。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><h2 class="section-title">快递取件助手</h2><p class="muted">私人版 · v3.1.33</p><p>集中查看短信取件码和已授权的线上包裹。</p><p class="small muted">日常短信识别在本机完成。个人使用，无广告，无需注册。</p></div>
        ${grouped('应用信息', U.row('检查更新', '', 'v3.1.33', 'update') + U.row('更新记录', '', '', 'changelog'))}
        <details class="card inset"><summary class="strong">许可与免责声明</summary><p class="small muted">木兰宽松许可证，第 2 版。原项目许可与免责声明随应用保留。</p>${demo('查看完整许可', '木兰宽松许可证，第 2 版 · 完整许可与免责声明。')}</details>
      </div>`
    },
    {
      id: 'changelog', title: '更新记录', group: '帮助', route: '/pages/my/changelog', back: 'about',
      description: '当前版本使用 3.1.33；旧版本内容折叠，未来更新只在更新场景中标注为示例。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>v3.1.33</strong>${U.badge('当前版本', 'blue')}</div><p class="small muted">11 月 7 日</p><ul class="stack gap-sm"><li>取件码与柜号更清楚地对齐显示。</li><li>站点识别更新后重新检查未分类包裹。</li><li>通知支持逐条关闭，新进展再次提醒。</li></ul></div>
        <details class="card inset"><summary class="strong">更早更新</summary><ul class="stack gap-sm"><li>保留人工修正与离线操作。</li><li>自动取件记录可定位具体包裹。</li><li>核验家人和指定账号的授权范围。</li><li>完善线上采集异常提示。</li></ul></details>
      </div>`
    },
    {
      id: 'update', title: '检查更新', group: '帮助', route: '/components/AppUpdate.vue · available', back: 'my', sheet: true,
      description: '有可用版本的更新弹层，当前版、来源、文件大小与说明均保留。',
      content: () => `<div class="stack">
        <div class="card inset">${U.kv('当前版本', 'v3.1.33')}${U.kv('下载来源', '已绑定后台')}</div>
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>发现新版本 v3.1.34（示例）</strong>${U.badge('42.8 MB', 'blue')}</div><ul class="stack gap-sm"><li>改进站点展示与取件状态提示。</li><li>完善更新失败后的重试说明。</li></ul></div>
        <details class="card inset"><summary class="text-action">其他检查结果</summary><p class="small muted">正在检查、已是最新版本、设备不兼容或网页预览不支持在线更新时，保留当前版本并说明具体状态。</p></details>
      </div>`,
      footer: () => U.button('下载更新', 'update-progress')
    },
    {
      id: 'update-progress', title: '下载更新', group: '帮助', route: '/components/AppUpdate.vue · downloading', back: 'my', sheet: true,
      description: '下载中保留字节进度和明确取消操作；关闭弹层不代表取消。',
      content: () => `<div class="stack">
        <div class="card inset">${U.kv('新版本', 'v3.1.34（示例）')}${U.kv('下载来源', '已绑定后台')}</div>
        <div class="card inset stack"><div class="hrow between"><strong>正在下载</strong><strong>64%</strong></div><progress class="progress" value="64" max="100" aria-label="更新包下载进度">64%</progress><p class="small muted">27.4 MB / 42.8 MB</p>${U.button('取消下载', 'update', 'secondary')}</div>
      </div>`
    },
    {
      id: 'update-ready', title: '准备安装', group: '帮助', route: '/components/AppUpdate.vue · ready', back: 'my', sheet: true,
      description: '展示准备完成与未知来源权限状态；安装仅进入 Android 流程，不伪造安装成功。',
      content: () => `<div class="stack">
        <div class="card inset stack gap-sm"><div class="hrow between"><strong>更新包已准备好</strong>${U.badge('v3.1.34（示例）', 'teal')}</div>${U.kv('安装包', '42.8 MB')}${U.kv('当前版本', 'v3.1.33')}</div>
        ${U.note('需要允许本应用安装未知来源应用。', 'amber')}
        <div class="card inset stack gap-sm"><strong>下一步</strong><p class="small muted">在 Android 设置中允许安装，返回此页再安装更新。安装前仍会校验安装包。</p></div>
        <details class="card inset"><summary class="text-action">已允许安装时</summary><p class="small muted">主按钮显示“安装更新”。正在校验时禁止重复提交；校验失败展示原因并重新下载。</p></details>
      </div>`,
      footer: () => U.button('去允许安装', '', 'primary')
    },
    {
      id: 'update-error', title: '更新未完成', group: '帮助', route: '/components/AppUpdate.vue · error', back: 'my', sheet: true,
      description: '下载失败与检查失败复用错误容器；保留真实原因和各自恢复操作。',
      content: () => `<div class="stack">
        ${U.note('下载中断，请检查网络后重试。', 'red')}
        <div class="card inset">${U.kv('当前版本', 'v3.1.33')}${U.kv('待下载版本', 'v3.1.34（示例）')}${U.kv('下载来源', '已绑定后台')}</div>
        ${U.button('重试下载', 'update-progress')}${U.button('重新检查', 'update', 'secondary')}
        <details class="card inset"><summary class="text-action">检查失败或设备不兼容</summary><p class="small muted">没有有效新版本信息时只提供“重试检查”。设备不兼容时显示系统要求，网页预览则引导使用 Android 安装版。</p></details>
      </div>`
    }
  ];
  window.SCENES.push(...scenes);
})();
