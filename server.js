const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const SteamCardFarmer = require('./steamFarmer');
const { exec } = require('child_process');
const axios = require('axios');
const pkg = require('./package.json');

const CURRENT_VERSION = pkg.version;
let latestUpdate = null;

async function checkUpdate() {
    try {
        const repo = "Aperox/SteamCardFarmer";
        
        const res = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, { timeout: 5000 });
        const tag = res.data.tag_name.replace('v', '');
        
        if (tag !== CURRENT_VERSION) {
            latestUpdate = {
                version: res.data.tag_name,
                url: res.data.html_url,
                notes: res.data.name
            };
        }
    } catch(e) {}
}
// İlk açıldığında 5 saniye sonra kontrol et, sonra her 12 saatte bir et
setTimeout(checkUpdate, 5000);
setInterval(checkUpdate, 12 * 60 * 60 * 1000);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'templates'), {
    etag: false,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

let farmer = null;
let sysLogs = [];

function addLog(msg, type = "info") {
    const ts = new Date().toLocaleTimeString("tr-TR");
    sysLogs.unshift({ time: ts, level: type, msg: msg });
    if (sysLogs.length > 100) sysLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

let appSettings = { limit: 1, solo: true, state: 7, auto_login: true, ignore_comp: true, schedule_enabled: false, schedule_start: "", schedule_stop: "" };
const SESSION_FILE = path.join(__dirname, 'session.json');

app.get('/api/settings', (req, res) => {
    res.json({ success: true, settings: appSettings });
});

app.post('/api/settings', (req, res) => {
    try {
        appSettings = { ...appSettings, ...req.body };
        if (farmer) {
            farmer.updateSettings(appSettings);
        }
        res.json({ success: true, settings: appSettings });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/status', (req, res) => {
    if (!farmer) {
        return res.json({
            logged_in: false,
            needs_code: false,
            code_type: null,
            is_farming: false,
            stats: {},
            log: sysLogs.slice(0, 100),
            current_games: [],
            update: latestUpdate
        });
    }

    res.json({
        logged_in: farmer.isLoggedIn(),
        needs_code: farmer.isAwaitingCode(),
        code_type: farmer.getCodeType(),
        is_farming: farmer.isFarming(),
        stats: farmer.getStats(),
        log: sysLogs.slice(0, 100),
        current_games: farmer.getCurrentGames(),
        profile_name: farmer.profileName,
        profile_avatar: farmer.profileAvatar,
        update: latestUpdate,
        alert: farmer.pendingAlert,
        settings: appSettings
    });
});

app.get('/api/clear_alert', (req, res) => {
    if (farmer) {
        if (farmer.pendingAlert && farmer.pendingAlert.auto_disabled) {
            appSettings.schedule_enabled = false;
            try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); } catch(e) {}
        }
        farmer.pendingAlert = null;
    }
    res.json({success: true});
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, error: "Kullanıcı adı ve şifre zorunludur." });
    }

    try {
        if (farmer) {
            farmer.logout();
        }
        farmer = new SteamCardFarmer(username, password, addLog);
        farmer.updateSettings(appSettings);
        const result = await farmer.login();
        
        if (result.success) {
            addLog(`✅ ${username} giriş başarılı.`, "success");
        } else if (result.needs_code) {
            if (result.code_type === "email") {
                addLog("📧 Email doğrulama kodu gönderildi.", "info");
            } else {
                addLog("📱 Steam Guard kodu gerekiyor.", "info");
            }
        } else {
            addLog(`❌ ${result.error || "Giriş başarısız"}`, "error");
        }
        
        res.json(result);
    } catch (e) {
        addLog(`❌ Hata: ${e.message}`, "error");
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/submit_code', async (req, res) => {
    if (!farmer) return res.json({ success: false, error: "Önce giriş başlatın." });
    
    const { code } = req.body;
    if (!code) return res.json({ success: false, error: "Kod boş olamaz." });

    try {
        const result = await farmer.submitCode(code);
        res.json(result);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/start', async (req, res) => {
    if (!farmer || !farmer.isLoggedIn()) {
        return res.json({ success: false, error: "Önce giriş yapmalısınız." });
    }

    if (farmer.isFarming()) {
        return res.json({ success: false, error: "Zaten çalışıyor." });
    }

    const { app_ids } = req.body;
    // We intentionally don't await startFarming here so it runs in background
    farmer.startFarming(app_ids);
    addLog("▶ Farming işlemi başlatıldı.", "info");
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    if (!farmer) return res.json({ success: false, error: "Farmer çalışmıyor." });
    farmer.stop();
    addLog("⏹ Farming işlemi durduruldu.", "warning");
    res.json({ success: true });
});

app.get('/api/games', async (req, res) => {
    if (!farmer || !farmer.isLoggedIn()) {
        return res.json({ success: false, error: "Oturum açılmadı." });
    }
    try {
        const games = await farmer.getGamesWithDrops();
        res.json({ success: true, games: games });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/history', (req, res) => {
    try {
        const histPath = require('path').join(__dirname, 'history.json');
        if (fs.existsSync(histPath)) {
            const hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
            res.json({ success: true, history: hist });
        } else {
            res.json({ success: true, history: {} });
        }
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/logout', (req, res) => {
    if (farmer) {
        farmer.logout();
    }
    farmer = null;
    if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
    }
    addLog("🚪 Çıkış yapıldı.", "info");
    res.json({ success: true });
});

app.post('/api/auto_login', async (req, res) => {
    if (farmer && farmer.isLoggedIn()) {
        return res.json({ success: true });
    }
    if (appSettings.auto_login === false) {
        return res.json({ success: false });
    }
    if (!fs.existsSync(SESSION_FILE)) {
        return res.json({ success: false });
    }

    try {
        const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        if (!sessionData.accountName || !sessionData.refreshToken) {
            return res.json({ success: false });
        }
        
        farmer = new SteamCardFarmer(sessionData.accountName, "", addLog);
        farmer.updateSettings(appSettings);
        
        const result = await farmer.autoLogin(sessionData.refreshToken);
        if (result.success) {
            addLog(`✅ ${sessionData.accountName} otomatik giriş başarılı.`, "success");
        } else {
            addLog(`❌ Otomatik giriş başarısız: ${result.error || "Bilinmeyen hata"}`, "error");
            if (fs.existsSync(SESSION_FILE)) {
                fs.unlinkSync(SESSION_FILE); // Clear invalid session
            }
        }
        res.json(result);
    } catch (e) {
        addLog(`❌ Otomatik giriş sırasında hata: ${e.message}`, "error");
        if (fs.existsSync(SESSION_FILE)) {
            fs.unlinkSync(SESSION_FILE); // Clear invalid session
        }
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/quit', (req, res) => {
    addLog("Kapatma isteği alındı. Sunucu durduruluyor...", "warning");
    if (farmer) farmer.logout();
    res.json({ success: true });
    setTimeout(() => {
        process.exit(0);
    }, 500);
});

const PORT = 5000;
app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 Sunucu çalışıyor: http://127.0.0.1:${PORT}`);
    
    try {
        if (process.platform === 'win32') {
            exec(`start http://127.0.0.1:${PORT}`);
        }
    } catch(e) {
        console.error("Tarayıcı açılamadı:", e);
    }
});
