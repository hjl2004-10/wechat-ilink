/**
 * WeChat iLink Server Plugin
 *
 * Server-side proxy for WeChat iLink Bot API requests.
 * Eliminates the need for enableCorsProxy by proxying requests through Node.js.
 */

async function init(router) {
    router.post('/proxy', async (req, res) => {
        try {
            const { url, method, headers, body } = req.body;

            if (!url || !url.startsWith('https://')) {
                return res.status(400).json({ error: 'Invalid URL' });
            }

            const fetchOpts = {
                method: method || 'GET',
                headers: headers || {},
            };
            if (body) fetchOpts.body = JSON.stringify(body);

            const response = await fetch(url, fetchOpts);
            const text = await response.text();

            res.status(response.status);
            res.setHeader('Content-Type', 'application/json');
            res.send(text);
        } catch (err) {
            console.error('[WeChat iLink Plugin] Proxy error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    console.log('WeChat iLink server plugin loaded!');
    return Promise.resolve();
}

async function exit() {
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: 'wechat-ilink',
        name: 'WeChat iLink',
        description: 'Server-side proxy for WeChat iLink Bot API',
    },
};
