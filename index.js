// ==SillyTavern Extension==
// @name         WeChat iLink
// @version      1.2.0
// @description  连接微信 iLink 协议，实现 SillyTavern 与微信的消息互通
// @author       WeChat-iLink
// @license      MIT

(function () {
    const EXT_NAME = 'wechat-ilink';

    const DEFAULT_SETTINGS = {
        apiBase: 'https://ilinkai.weixin.qq.com',
        wechatUin: '',
        botToken: '',
        ilinkBotId: '',
        isConnected: false,
        pollInterval: 3,
        injectInput: true,       // 是否将微信消息填入输入框
        autoSendInput: true,     // 是否自动发送填入的消息（触发AI）— 依赖 injectInput
        autoPushReply: true,     // 是否自动回推AI回复到微信
        cleanMarkdown: true,     // 发送前清理 Markdown 格式
        sendPrefix: '',          // 发送内容前缀
        sendSuffix: '',          // 发送内容后缀
        customReplaces: '',      // 自定义替换规则 (每行一条: 匹配内容=>替换内容)
        showDebug: false,
        getUpdatesBuf: '',
        lastContextToken: '',
        lastFromUserId: '',
    };

    let pollTimerId = null;
    let isPolling = false;
    let pendingWeChatReply = false;    // 标记当前是否有微信触发的生成在进行

    function ST() {
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
        } catch { }
        return null;
    }

    function settings() {
        return ST()?.extensionSettings?.[EXT_NAME] || null;
    }

    function log(...args) {
        if (settings()?.showDebug) console.log('[WeChat iLink]', ...args);
    }

    function generateUin() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let r = '';
        for (let i = 0; i < 24; i++) r += chars[Math.floor(Math.random() * chars.length)];
        return r;
    }

    function saveSettings() {
        try { ST()?.saveSettingsDebounced?.(); } catch { }
    }

    // ==================== API ====================

    async function iLinkFetch(path, options = {}) {
        const s = settings();
        if (!s) throw new Error('扩展设置未加载');

        const headers = {
            'Content-Type': 'application/json',
            'X-WECHAT-UIN': s.wechatUin || generateUin(),
        };
        if (s.botToken) {
            headers['Authorization'] = `Bearer ${s.botToken}`;
            headers['AuthorizationType'] = 'ilink_bot_token';
        }

        const url = `${s.apiBase}${path}`;
        const fetchOpts = {
            method: options.method || 'GET',
            headers,
        };
        if (options.body) fetchOpts.body = JSON.stringify(options.body);

        // encodeURIComponent 避免 https:// 双斜杠被 Express 规范化
        const proxyUrl = `/proxy/${encodeURIComponent(url)}`;

        let resp;
        try {
            resp = await fetch(proxyUrl, fetchOpts);
        } catch (networkErr) {
            throw networkErr;
        }

        // 401/403 说明 ST 服务器本身需要认证，不是微信接口问题
        // 停止轮询，避免浏览器反复弹出密码框
        if (resp.status === 401 || resp.status === 403) {
            stopPolling();
            console.warn('[WeChat iLink] ST 服务器需要认证 (', resp.status, ')，已停止轮询');
            throw new Error(`ST 服务器认证失败 (${resp.status})，请检查密码设置`);
        }

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`iLink error (${resp.status}): ${txt}`);
        }
        return resp.json();
    }

    // ==================== QR Login ====================

    async function startQRLogin() {
        const $dot = $('#wechat_ilink_status_dot');
        const $txt = $('#wechat_ilink_status_text');
        const $qrImg = $('#wechat_ilink_qrcode');
        const $placeholder = $('#wechat_ilink_qr_placeholder');
        const $status = $('#wechat_ilink_qr_status');

        try {
            $dot.attr('class', 'wechat-ilink-dot connecting');
            $txt.text('获取二维码中...');
            $status.show().text('正在请求...');

            const data = await iLinkFetch('/ilink/bot/get_bot_qrcode?bot_type=3');
            log('QR response:', data);

            if (data.ret !== 0) throw new Error(data.err_msg || '获取二维码失败');

            const qrUrl = data.qrcode_img_content;
            const sessionKey = data.qrcode;

            if (!qrUrl || !sessionKey) throw new Error('二维码数据不完整');

            // 用 QRCode.js 在前端生成二维码图片
            $qrImg.hide();
            const $container = $('#wechat_ilink_qr_canvas');
            $container.empty().show();
            new QRCode($container[0], {
                text: qrUrl,
                width: 200,
                height: 200,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M,
            });
            $placeholder.hide();
            $status.show().text('请用微信扫描二维码');

            pollQRStatus(sessionKey);
        } catch (err) {
            console.error('[WeChat iLink] QR error:', err);
            toastr.error(err.message, '微信登录失败');
            $dot.attr('class', 'wechat-ilink-dot offline');
            $txt.text('获取失败');
            $status.show().text('错误: ' + err.message);
        }
    }

    function pollQRStatus(sessionKey) {
        const $status = $('#wechat_ilink_qr_status');
        let attempts = 0;

        const poll = async () => {
            if (attempts >= 90) {
                $status.text('二维码已过期，请重新获取');
                $('#wechat_ilink_status_dot').attr('class', 'wechat-ilink-dot offline');
                $('#wechat_ilink_status_text').text('已过期');
                return;
            }
            attempts++;

            try {
                const data = await iLinkFetch(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(sessionKey)}`);
                log('QR status:', data);

                const status = data.status;

                if (status === 'confirmed') {
                    const s = settings();
                    s.botToken = data.bot_token;
                    s.ilinkBotId = data.ilink_bot_id || '';
                    s.isConnected = true;
                    s.getUpdatesBuf = '';
                    updateConnectionUI(true);
                    $status.text('登录成功！');
                    saveSettings();
                    startPolling();
                    toastr.success('微信机器人连接成功！');
                    return;
                }

                if (status === 'scaned') {
                    $status.text('已扫码，请在手机上确认...');
                } else if (status === 'expired') {
                    $status.text('二维码已过期，请重新获取');
                    return;
                } else {
                    $status.text(`等待扫码... (${attempts})`);
                }

                setTimeout(poll, 2000);
            } catch (err) {
                log('QR poll error:', err);
                // 认证失败不重试
                if (err.message && err.message.includes('认证失败')) {
                    $status.text('ST 服务器认证失败，请刷新页面后重新登录');
                    return;
                }
                setTimeout(poll, 3000);
            }
        };

        poll();
    }

    // ==================== getUpdates ====================

    async function pollUpdates() {
        if (isPolling) return;
        const s = settings();
        if (!s?.isConnected || !s.botToken) return;

        isPolling = true;
        try {
            const body = { base_info: { channel_version: '1.0.0' } };
            if (s.getUpdatesBuf) body.get_updates_buf = s.getUpdatesBuf;

            const data = await iLinkFetch('/ilink/bot/getupdates', { method: 'POST', body });
            log('getupdates:', data);

            if (data.get_updates_buf) {
                s.getUpdatesBuf = data.get_updates_buf;
            }

            const msgs = data.msgs || [];
            for (const msg of msgs) {
                await handleMessage(msg);
            }
        } catch (err) {
            log('pollUpdates error:', err);
            // ST 服务器认证失败：停止轮询并提示用户
            if (err.message && err.message.includes('认证失败')) {
                toastr.error('ST 服务器需要重新认证，轮询已停止', 'WeChat iLink');
            }
        } finally {
            isPolling = false;
        }
    }

    async function handleMessage(msg) {
        const s = settings();
        log('incoming msg:', msg);

        // 提取文本（只处理文字消息）
        const textItem = msg.item_list?.find(i => i.type === 1);
        const text = textItem?.text_item?.text || '';
        if (!text) return;

        const fromUserId = msg.from_user_id || '';
        const contextToken = msg.context_token || '';

        // 保存 context_token 和 from_user_id 用于回复
        if (contextToken) s.lastContextToken = contextToken;
        if (fromUserId) s.lastFromUserId = fromUserId;
        saveSettings();

        const ctx = ST();
        if (!ctx) return;

        // 必须有选中的角色和聊天
        if (!ctx.characterId && ctx.characterId !== 0) {
            log('No character selected, skipping message');
            toastr.warning('请先选择一个角色', 'WeChat iLink');
            return;
        }

        // 开关1: 是否填入输入框
        if (!s.injectInput) {
            log('injectInput disabled, skipping');
            return;
        }

        const $textarea = $('#send_textarea');
        if (!$textarea.length) {
            log('Textarea not found');
            return;
        }

        // 开关2: 是否自动发送（触发AI生成）
        if (s.autoSendInput) {
            // 填入并自动点发送
            pendingWeChatReply = true;
            $textarea.val(text);
            $('#send_but').trigger('click');
            log('Message auto-sent:', text);
        } else {
            // 只填入，不发送，用户手动点发送
            $textarea.val(text).trigger('input');
            log('Message filled (manual send):', text);
            toastr.info(`微信消息已填入: ${text.substring(0, 30)}...`, 'WeChat iLink');
        }
    }

    // ==================== 发送格式化 ====================

    function formatForWeChat(text) {
        const s = settings();
        if (!s) return text;

        let result = text;

        // 清理 Markdown 格式
        if (s.cleanMarkdown) {
            // 代码块 ```...``` → 保留内容
            result = result.replace(/```[\s\S]*?```/g, (match) => {
                return match.replace(/```\w*\n?/g, '').replace(/```/g, '').trim();
            });
            // 行内代码 `...`
            result = result.replace(/`([^`]+)`/g, '$1');
            // 粗斜体 ***...*** 或 ___...___
            result = result.replace(/\*{3}(.+?)\*{3}/g, '$1');
            result = result.replace(/_{3}(.+?)_{3}/g, '$1');
            // 粗体 **...** 或 __...__
            result = result.replace(/\*{2}(.+?)\*{2}/g, '$1');
            result = result.replace(/_{2}(.+?)_{2}/g, '$1');
            // 斜体 *...* 或 _..._
            result = result.replace(/\*(.+?)\*/g, '$1');
            result = result.replace(/_(.+?)_/g, '$1');
            // 删除线 ~~...~~
            result = result.replace(/~~(.+?)~~/g, '$1');
            // 标题 # ## ### 等
            result = result.replace(/^#{1,6}\s+/gm, '');
            // 引用 >
            result = result.replace(/^>\s?/gm, '');
            // 无序列表 - * +
            result = result.replace(/^[\s]*[-*+]\s+/gm, '• ');
            // 有序列表 1. 2. 3.
            result = result.replace(/^[\s]*\d+\.\s+/gm, (match) => match.trim() + ' ');
            // 分隔线 --- *** ___
            result = result.replace(/^[-*_]{3,}\s*$/gm, '');
            // 链接 [text](url) → text
            result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
            // 图片 ![alt](url) → [图片]
            result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图片]');
            // 清理多余空行
            result = result.replace(/\n{3,}/g, '\n\n');
        }

        // 自定义替换规则
        if (s.customReplaces) {
            const lines = s.customReplaces.split('\n').filter(l => l.includes('=>'));
            for (const line of lines) {
                const idx = line.indexOf('=>');
                const from = line.substring(0, idx);
                const to = line.substring(idx + 2);
                if (from) {
                    try {
                        result = result.replace(new RegExp(from, 'g'), to);
                    } catch {
                        result = result.split(from).join(to);
                    }
                }
            }
        }

        // 前缀后缀（支持 \n 转义为换行）
        if (s.sendPrefix) result = s.sendPrefix.replace(/\\n/g, '\n') + result;
        if (s.sendSuffix) result = result + s.sendSuffix.replace(/\\n/g, '\n');

        return result.trim();
    }

    // ==================== sendmessage ====================

    async function sendToWeChat(rawText) {
        const s = settings();
        if (!s?.isConnected || !s.botToken) {
            toastr.warning('微信未连接');
            return false;
        }

        const token = s.lastContextToken;
        if (!token) {
            toastr.warning('没有 context_token，请先从微信发一条消息');
            return false;
        }

        // 格式化文本
        const text = formatForWeChat(rawText);
        if (!text) {
            log('Formatted text is empty, skipping send');
            return false;
        }

        const clientId = `st-ilink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        try {
            const data = await iLinkFetch('/ilink/bot/sendmessage', {
                method: 'POST',
                body: {
                    msg: {
                        from_user_id: s.ilinkBotId || '',
                        to_user_id: s.lastFromUserId || '',
                        client_id: clientId,
                        message_type: 2,
                        message_state: 2,
                        context_token: token,
                        item_list: [{ type: 1, text_item: { text } }],
                    },
                    base_info: { channel_version: '1.0.0' },
                },
            });
            log('sendmessage response:', data);
            // 微信返回空对象 {} 也算成功（ret 为 undefined 时不报错）
            if (data.ret !== undefined && data.ret !== 0) {
                throw new Error(data.err_msg || '发送失败');
            }
            log('Sent to WeChat successfully');
            return true;
        } catch (err) {
            console.error('[WeChat iLink] send error:', err);
            toastr.error(err.message, '发送到微信失败');
            return false;
        }
    }

    // ==================== Polling ====================

    function startPolling() {
        stopPolling();
        const s = settings();
        if (!s?.isConnected || !s.botToken) return;
        const interval = Math.max(1, s.pollInterval || 3) * 1000;
        pollUpdates();
        pollTimerId = setInterval(pollUpdates, interval);
        log('Polling started, interval:', interval);
    }

    function stopPolling() {
        if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }
        isPolling = false;
    }

    // ==================== UI ====================

    function updateConnectionUI(connected) {
        const $dot = $('#wechat_ilink_status_dot');
        const $txt = $('#wechat_ilink_status_text');
        const $disconnect = $('#wechat_ilink_disconnect');
        const $getQr = $('#wechat_ilink_get_qr');
        const $qrImg = $('#wechat_ilink_qrcode');
        const $placeholder = $('#wechat_ilink_qr_placeholder');
        const $qrStatus = $('#wechat_ilink_qr_status');

        const $qrCanvas = $('#wechat_ilink_qr_canvas');

        if (connected) {
            $dot.attr('class', 'wechat-ilink-dot online');
            $txt.text('已连接');
            $disconnect.show();
            $getQr.hide();
            $qrImg.hide();
            $qrCanvas.hide().empty();
            $placeholder.show().html('<i class="fa-solid fa-check-circle" style="font-size:48px;color:#2ecc71;opacity:0.9;"></i><span style="color:#2ecc71;margin-top:8px;">已连接</span>');
            $qrStatus.hide();
        } else {
            $dot.attr('class', 'wechat-ilink-dot offline');
            $txt.text('未连接');
            $disconnect.hide();
            $getQr.show();
            $qrImg.hide();
            $qrCanvas.hide().empty();
            $placeholder.show().html('<i class="fa-solid fa-qrcode"></i><span>点击下方按钮获取二维码</span>');
            $qrStatus.hide();
        }
    }

    // 更新"自动发送"复选框的可用状态
    function updateAutoSendState() {
        const s = settings();
        if (!s) return;
        const $autoSend = $('#wechat_ilink_auto_send_input');
        if (s.injectInput) {
            $autoSend.prop('disabled', false).closest('label').css('opacity', '1');
        } else {
            $autoSend.prop('disabled', true).closest('label').css('opacity', '0.5');
        }
    }

    function initSettings() {
        const ctx = ST();
        if (!ctx?.extensionSettings) return false;

        const es = ctx.extensionSettings;
        es[EXT_NAME] = es[EXT_NAME] || {};

        // 填充缺失的 key
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (es[EXT_NAME][k] === undefined) es[EXT_NAME][k] = v;
        }

        // 迁移旧设置名
        const s = es[EXT_NAME];
        if (s.autoReply !== undefined && s.autoPushReply === undefined) {
            s.autoPushReply = s.autoReply;
        }
        if (s.forwardToChat !== undefined && s.injectInput === undefined) {
            s.injectInput = s.forwardToChat;
        }

        if (!s.wechatUin) {
            s.wechatUin = generateUin();
        }

        $('#wechat_ilink_api_base').val(s.apiBase);
        $('#wechat_ilink_wechat_uin').val(s.wechatUin);
        $('#wechat_ilink_poll_interval').val(s.pollInterval);
        $('#wechat_ilink_inject_input').prop('checked', !!s.injectInput);
        $('#wechat_ilink_auto_send_input').prop('checked', !!s.autoSendInput);
        $('#wechat_ilink_auto_push_reply').prop('checked', !!s.autoPushReply);
        $('#wechat_ilink_clean_markdown').prop('checked', !!s.cleanMarkdown);
        $('#wechat_ilink_send_prefix').val(s.sendPrefix || '');
        $('#wechat_ilink_send_suffix').val(s.sendSuffix || '');
        $('#wechat_ilink_custom_replaces').val(s.customReplaces || '');
        $('#wechat_ilink_show_debug').prop('checked', !!s.showDebug);

        updateConnectionUI(s.isConnected && !!s.botToken);
        updateAutoSendState();

        if (s.isConnected && s.botToken) startPolling();

        return true;
    }

    function onDisconnect() {
        const s = settings();
        if (!s) return;
        stopPolling();
        Object.assign(s, { botToken: '', ilinkBotId: '', isConnected: false, getUpdatesBuf: '', lastContextToken: '', lastFromUserId: '' });
        updateConnectionUI(false);
        saveSettings();
        toastr.info('已断开微信连接');
    }

    async function onSendLastReply() {
        const ctx = ST();
        if (!ctx?.chat) return;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (!m.is_user && !m.is_system && m.mes) {
                const ok = await sendToWeChat(m.mes);
                if (ok) toastr.success('已发送到微信');
                return;
            }
        }
        toastr.warning('找不到 AI 回复消息');
    }

    // ==================== 定时发送 ====================

    let scheduledTimerId = null;
    let scheduledCount = 0;

    function startScheduledSend() {
        stopScheduledSend();

        const content = $('#wechat_ilink_scheduled_content').val().trim();
        const source = $('#wechat_ilink_scheduled_source').val();
        const interval = Math.max(1, parseInt($('#wechat_ilink_scheduled_interval').val()) || 60);
        const maxCount = parseInt($('#wechat_ilink_scheduled_count').val()) || 0; // 0 = 无限

        if (source === 'custom' && !content) {
            toastr.warning('请填写发送内容');
            return;
        }

        const s = settings();
        if (!s?.isConnected) {
            toastr.warning('微信未连接');
            return;
        }
        if (!s.lastContextToken) {
            toastr.warning('没有 context_token，请先从微信发一条消息');
            return;
        }

        scheduledCount = 0;
        updateScheduledUI(true);
        log('Scheduled send started, interval:', interval, 'max:', maxCount || '∞');

        const doSend = async () => {
            let text = '';

            if (source === 'custom') {
                text = content;
            } else if (source === 'last_ai') {
                const ctx = ST();
                if (ctx?.chat) {
                    for (let i = ctx.chat.length - 1; i >= 0; i--) {
                        const m = ctx.chat[i];
                        if (!m.is_user && !m.is_system && m.mes) {
                            text = m.mes;
                            break;
                        }
                    }
                }
                if (!text) {
                    log('No AI reply found for scheduled send');
                    return;
                }
            }

            scheduledCount++;
            const countText = maxCount > 0 ? `${scheduledCount}/${maxCount}` : `${scheduledCount}`;
            $('#wechat_ilink_scheduled_status').text(`已发送 ${countText} 次`);
            log('Scheduled send #' + scheduledCount, text.substring(0, 50));

            await sendToWeChat(text);

            if (maxCount > 0 && scheduledCount >= maxCount) {
                stopScheduledSend();
                toastr.info(`定时发送完成（共 ${maxCount} 次）`);
            }
        };

        // 立即发一次
        doSend();
        scheduledTimerId = setInterval(doSend, interval * 1000);
    }

    function stopScheduledSend() {
        if (scheduledTimerId) {
            clearInterval(scheduledTimerId);
            scheduledTimerId = null;
        }
        updateScheduledUI(false);
    }

    function updateScheduledUI(running) {
        $('#wechat_ilink_scheduled_start').toggle(!running);
        $('#wechat_ilink_scheduled_stop').toggle(running);
        $('#wechat_ilink_scheduled_source, #wechat_ilink_scheduled_content, #wechat_ilink_scheduled_interval, #wechat_ilink_scheduled_count')
            .prop('disabled', running);

        if (!running) {
            if (scheduledCount > 0) {
                $('#wechat_ilink_scheduled_status').text(`已停止（共发送 ${scheduledCount} 次）`);
            } else {
                $('#wechat_ilink_scheduled_status').text('');
            }
        }
    }

    // ==================== Init ====================

    jQuery(async function () {
        try {
            console.log('[WeChat iLink] Initializing...');

            // 加载 QRCode.js 库
            await $.getScript('/scripts/extensions/third-party/wechat-ilink/qrcode.min.js');

            const html = await $.get('/scripts/extensions/third-party/wechat-ilink/settings.html');
            $('#extensions_settings').append(html);

            // 等待 ST 就绪
            let ok = false;
            for (let i = 0; i < 20; i++) {
                ok = initSettings();
                if (ok) break;
                await new Promise(r => setTimeout(r, 300));
            }
            if (!ok) {
                console.error('[WeChat iLink] ST context not ready');
                toastr.error('扩展加载失败，请刷新', 'WeChat iLink');
                return;
            }

            // 绑定按钮
            $('#wechat_ilink_get_qr').on('click', startQRLogin);
            $('#wechat_ilink_disconnect').on('click', onDisconnect);
            $('#wechat_ilink_send_last').on('click', onSendLastReply);
            $('#wechat_ilink_scheduled_start').on('click', startScheduledSend);
            $('#wechat_ilink_scheduled_stop').on('click', stopScheduledSend);
            // 内容来源切换时，显示/隐藏自定义内容框
            $('#wechat_ilink_scheduled_source').on('change', function () {
                $('#wechat_ilink_scheduled_content').toggle($(this).val() === 'custom');
            });

            // 绑定设置输入
            $('#wechat_ilink_api_base').on('input', function () {
                const s = settings(); if (s) { s.apiBase = $(this).val().trim(); saveSettings(); }
            });
            $('#wechat_ilink_wechat_uin').on('input', function () {
                const s = settings(); if (s) { s.wechatUin = $(this).val().trim(); saveSettings(); }
            });
            $('#wechat_ilink_poll_interval').on('change', function () {
                const s = settings(); if (s) { s.pollInterval = Number($(this).val()); if (s.isConnected) startPolling(); saveSettings(); }
            });
            $('#wechat_ilink_inject_input').on('change', function () {
                const s = settings(); if (s) { s.injectInput = $(this).prop('checked'); updateAutoSendState(); saveSettings(); }
            });
            $('#wechat_ilink_auto_send_input').on('change', function () {
                const s = settings(); if (s) { s.autoSendInput = $(this).prop('checked'); saveSettings(); }
            });
            $('#wechat_ilink_auto_push_reply').on('change', function () {
                const s = settings(); if (s) { s.autoPushReply = $(this).prop('checked'); saveSettings(); }
            });
            $('#wechat_ilink_clean_markdown').on('change', function () {
                const s = settings(); if (s) { s.cleanMarkdown = $(this).prop('checked'); saveSettings(); }
            });
            $('#wechat_ilink_send_prefix').on('input', function () {
                const s = settings(); if (s) { s.sendPrefix = $(this).val(); saveSettings(); }
            });
            $('#wechat_ilink_send_suffix').on('input', function () {
                const s = settings(); if (s) { s.sendSuffix = $(this).val(); saveSettings(); }
            });
            $('#wechat_ilink_custom_replaces').on('input', function () {
                const s = settings(); if (s) { s.customReplaces = $(this).val(); saveSettings(); }
            });
            $('#wechat_ilink_show_debug').on('change', function () {
                const s = settings(); if (s) { s.showDebug = $(this).prop('checked'); saveSettings(); }
            });

            // 监听 AI 回复事件，自动回推到微信
            const ctx = ST();
            if (ctx?.eventSource && ctx?.eventTypes) {
                ctx.eventSource.on(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
                    const s = settings();
                    // 必须满足：已连接 + 开启自动回推 + 是微信触发的生成
                    if (!s?.isConnected || !s.autoPushReply) return;
                    if (!pendingWeChatReply) return;  // 不是微信触发的，不回推

                    pendingWeChatReply = false;

                    const msg = ctx.chat?.[messageId];
                    if (!msg || msg.is_user || msg.is_system) return;

                    log('Auto-pushing AI reply to WeChat, messageId:', messageId);
                    const ok = await sendToWeChat(msg.mes);
                    if (ok) {
                        log('Auto-push successful');
                    }
                });
            }

            console.log('[WeChat iLink] Ready');
        } catch (err) {
            console.error('[WeChat iLink] Init failed:', err);
        }
    });
})();
