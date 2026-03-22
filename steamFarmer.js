const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

class SteamCardFarmer {
    constructor(username, password, logCallback) {
        this.username = username;
        this.password = password;
        this.log = logCallback || console.log;

        this.client = new SteamUser();
        this.community = new SteamCommunity();

        this.loggedIn = false;
        this.needsCode = false;
        this.codeType = null;
        this.farming = false;

        this.stats = {
            cards_dropped: 0,
            games_completed: 0,
            total_playtime_min: 0
        };
        this.currentGames = [];
        this.sessionStart = null;
        this.gamesToFarm = [];
        this.totalRemainingDrops = 0;
        this._newItemsReceived = false;

        this.profileName = null;
        this.profileAvatar = "https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";

        this.loginPromise = null;
        this.codeResolve = null;

        this.settings = { limit: 1, solo: true, state: 7, schedule_enabled: false, schedule_start: "", schedule_stop: "" }; // default

        this._setupClientEvents();
        this._startScheduler();
    }

    _startScheduler() {
        if (this._schedulerInterval) clearInterval(this._schedulerInterval);
        this._schedulerInterval = setInterval(() => {
            if (!this.loggedIn || !this.settings.schedule_enabled) return;
            if (!this.settings.schedule_start && !this.settings.schedule_stop) return;

            const now = new Date();
            const currentHM = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

            // Gün kontrolü
            const today = now.getDay();
            const days = this.settings.schedule_days || [];
            
            // Eğer gün seçilmişse ve bugün o günlerden biri değilse, pas geç.
            if (days.length > 0 && !days.includes(today)) return;

            if (currentHM === this.settings.schedule_start && !this.farming) {
                this.log(`[ZAMANLAYICI] Otomatik başlatma saati (${currentHM}) geldi. Farming başlatılıyor...`, 'info');
                this.startFarming(null);
            } else if (currentHM === this.settings.schedule_stop && this.farming) {
                this.log(`[ZAMANLAYICI] Otomatik durdurma saati (${currentHM}) geldi. Farming durduruluyor...`, 'info');
                this.stop();
                
                // Bildirim ve ses ayarları varsa kuyruğa ekle
                if (this.settings.schedule_note || this.settings.schedule_sound) {
                    this.pendingAlert = { note: this.settings.schedule_note, sound: this.settings.schedule_sound };
                }

                // Haftalık tekrar (gün) girilmemişse => 1 kere çalış ve kendini tamamen kapat
                if (days.length === 0) {
                    this.settings.schedule_enabled = false;
                    this.log(`[ZAMANLAYICI] Tek seferlik zamanlayıcı görevini tamamladı. Tekrar otomatik kapatıldı.`, 'warning');
                    if (!this.pendingAlert) this.pendingAlert = {}; // Uyarı objemiz yoksa varsayılan boş uyarımız olsun
                    this.pendingAlert.auto_disabled = true; // Server'a settings.json'a kaydetme emri
                }
            }
        }, 20000); // Her 20 saniyede bir kontrol et (dakika atlamamak için)
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        if (this.loggedIn) {
            // Apply online state immediately if logged in
            this.client.setPersona(this.settings.state);
        }
    }

    _fetchProfileDetails() {
        if (!this.client.steamID) return;
        this.client.getPersonas([this.client.steamID], (personas) => {
            const sid64 = this.client.steamID.getSteamID64();
            const p = personas ? personas[sid64] : this.client.users[sid64];
            if (p && p.avatar_hash) {
                const hash = p.avatar_hash.toString('hex');
                if (hash !== "0000000000000000000000000000000000000000") {
                    this.profileAvatar = `https://avatars.akamai.steamstatic.com/${hash}_full.jpg`;
                    return;
                }
            }
            this.profileAvatar = "https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";
        });
    }

    _setupClientEvents() {
        this.client.on('error', (err) => {
            if (!this.loggedIn) return;
            this.log(`Steam Hatası: ${err.message}`, "error");
            this.farming = false;
        });

        this.client.on('disconnected', (eresult, msg) => {
            if (!this.loggedIn) return;
            this.log(`Steam bağlantısı kesildi. Sebep: ${msg}`, 'warning');
            this.loggedIn = false;
        });

        this.client.on('accountInfo', (name, country, authedMachines, flags, facebookID, facebookName) => {
            this.profileName = name;
        });
        
        this.client.on('refreshToken', (token) => {
            if (this.settings.auto_login !== false && this.username) {
                try {
                    const sessionPath = require('path').join(__dirname, 'session.json');
                    require('fs').writeFileSync(sessionPath, JSON.stringify({
                        accountName: this.username,
                        refreshToken: token
                    }));
                } catch(e) {}
            }
        });

        // Real-time card drop detection (like ASF)
        this.client.on('newItems', (count) => {
            if (count > 0 && this.farming) {
                this.log(`🃏 Yeni envanter bildirimi: ${count} yeni eşya algılandı! Kart kontrolü yapılıyor...`, "success");
                this._newItemsReceived = true;
            }
        });
    }

    login() {
        return new Promise((resolve) => {
            this.log("🔐 Steam sunucusuna bağlanılıyor...", "info");
            
            this.client.logOn({
                accountName: this.username,
                password: this.password
            });

            const onLoggedOn = (details) => {
                this.client.removeListener('error', onError);
                this.client.removeListener('steamGuard', onGuard);
                
                this.log(`✅ ${this.username} — giriş başarılı!`, "success");
                this.loggedIn = true;
                this.needsCode = false;
                this.sessionStart = Date.now();
                this.client.setPersona(this.settings.state);
                this._fetchProfileDetails();

                // Get web session for badge scraping
                this.client.webLogOn();
                this.client.once('webSession', (sessionID, cookies) => {
                    this.community.setCookies(cookies);
                    resolve({ success: true });
                });
            };

            const onGuard = (domain, callback, lastCodeWrong) => {
                this.log("⚠️ Steam Guard kodu isteniyor...", "info");
                this.needsCode = true;
                this.codeType = domain ? "email" : "totp";
                this.codeResolve = callback;

                let errorMsg = null;
                if (lastCodeWrong) {
                    errorMsg = "Kod yanlış veya süresi dolmuş. Yeni kodu girin.";
                }

                resolve({
                    success: false,
                    needs_code: true,
                    code_type: this.codeType,
                    error: errorMsg
                });
            };

            const onError = (err) => {
                this.client.removeListener('loggedOn', onLoggedOn);
                this.client.removeListener('steamGuard', onGuard);
                
                resolve({
                    success: false,
                    error: `Giriş başarısız: ${err.message}`
                });
            };

            this.client.once('loggedOn', onLoggedOn);
            this.client.once('steamGuard', onGuard);
            this.client.once('error', onError);
        });
    }

    submitCode(code) {
        return new Promise((resolve) => {
            if (!this.needsCode || !this.codeResolve) {
                return resolve({ success: false, error: "Şu an kod beklenmiyor." });
            }

            this.log("🔄 Kod doğrulanıyor...", "info");
            
            const onLoggedOn = () => {
                this.client.removeListener('error', onError);
                this.client.removeListener('steamGuard', onGuard);

                this.log(`✅ ${this.username} — giriş başarılı!`, "success");
                this.loggedIn = true;
                this.needsCode = false;
                this.sessionStart = Date.now();
                this.client.setPersona(this.settings.state);
                this._fetchProfileDetails();

                // Web session required to scrape badges
                this.client.webLogOn();
                this.client.once('webSession', (sessionID, cookies) => {
                    this.community.setCookies(cookies);
                    resolve({ success: true });
                });
            };

            const onError = (err) => {
                this.client.removeListener('loggedOn', onLoggedOn);
                this.client.removeListener('steamGuard', onGuard);
                resolve({ success: false, error: `Doğrulama hatası: ${err.message}` });
            };

            const onGuard = (domain, callback, lastCodeWrong) => {
                this.client.removeListener('loggedOn', onLoggedOn);
                this.client.removeListener('error', onError);
                
                this.codeResolve = callback;
                resolve({
                    success: false,
                    needs_code: true,
                    code_type: this.codeType,
                    error: "Geçersiz kod veya süresi dolmuş."
                });
            };

            this.client.once('loggedOn', onLoggedOn);
            this.client.once('error', onError);
            this.client.once('steamGuard', onGuard);
            
            try {
                this.codeResolve(code);
            } catch (e) {
                resolve({ success: false, error: "Kod gönderilirken bir hata oluştu." });
            }
        });
    }

    autoLogin(refreshToken) {
        return new Promise((resolve) => {
            this.log("🔄 Otomatik giriş yapılıyor (Oturum Jetonu ile)...", "info");
            
            this.client.logOn({
                refreshToken: refreshToken
            });

            const onLoggedOn = () => {
                this.client.removeListener('error', onError);
                
                this.loggedIn = true;
                this.needsCode = false;
                this.sessionStart = Date.now();
                this.client.setPersona(this.settings.state);
                this._fetchProfileDetails();

                this.client.webLogOn();
                this.client.once('webSession', (sessionID, cookies) => {
                    this.community.setCookies(cookies);
                    resolve({ success: true });
                });
            };

            const onError = (err) => {
                this.client.removeListener('loggedOn', onLoggedOn);
                resolve({ success: false, error: err.message });
            };

            this.client.once('loggedOn', onLoggedOn);
            this.client.once('error', onError);
        });
    }

    logout() {
        if (this.client) {
            this.client.logOff();
        }
        this.loggedIn = false;
        this.farming = false;
        this.sessionStart = null;
        this.gamesToFarm = [];
        this.totalRemainingDrops = 0;
    }

    isLoggedIn() { return this.loggedIn; }
    isAwaitingCode() { return this.needsCode; }
    getCodeType() { return this.needsCode ? this.codeType : null; }
    isFarming() { return this.farming; }
    getCurrentGames() { return this.currentGames; }
    
    getStats() {
        return {
            ...this.stats,
            session_duration_min: this.sessionStart ? Math.floor((Date.now() - this.sessionStart) / 60000) : 0,
            total_remaining_drops: this.totalRemainingDrops
        };
    }

    updateTotalDrops() {
        this.totalRemainingDrops = this.gamesToFarm.reduce((sum, g) => sum + g.remaining_drops, 0);
    }

    async getGamesWithDrops() {
        this.log("📋 Kütüphane taranıyor (Oyunlarım sayfası okunuyor)...", "info");

        const allGamesMap = new Map();

        // 1. Fetch complete game library from /my/games/?tab=all (bypasses Steam's limited account restrictions)
        try {
            const games = await this._fetchOwnedGames();
            games.forEach(g => {
                // Ensure every game is correctly formatted and pushed explicitly
                allGamesMap.set(g.app_id, {
                    app_id: g.app_id,
                    name: g.name,
                    remaining_drops: 0,
                    playtime_min: g.playtime_min,
                    needs_playtime_hack: g.needs_playtime_hack,
                    image_url: g.image_url
                });
            });
            this.log(`📋 Kütüphanede toplam ${games.length} oyun tespit edildi.`, "info");
        } catch (err) {
            this.log(`⚠ Oyunlarım dizini okunamadı: ${err.message}`, "warning");
        }

        // 2. Fetch badges page to find which games have remaining card drops
        this.log("📋 Kart düşme istatistikleri eşleştiriliyor (Rozetler okunuyor)...", "info");
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
            try {
                const { games: badgeGames, maxPage } = await this._fetchBadgesPage(page);
                
                badgeGames.forEach(badge => {
                    if (allGamesMap.has(badge.app_id)) {
                        // Merge the drop stats directly into the existing game
                        const game = allGamesMap.get(badge.app_id);
                        game.remaining_drops = badge.remaining_drops;
                        // Use the badge page's playtime hack logic since it's most accurate for dropping
                        game.needs_playtime_hack = badge.needs_playtime_hack;
                    } else {
                        // If it's somehow missing from the main library, add it
                        allGamesMap.set(badge.app_id, badge);
                    }
                });

                if (maxPage > totalPages) {
                    totalPages = maxPage;
                }
                this.log(`📋 Sayfa ${page}/${totalPages} kart verisi işlendi...`, "info");
                page++;
            } catch (err) {
                this.log(`⚠ Badge sayfası (Sayfa ${page}) yüklenemedi.`, "warning");
                break;
            }
        }

        const uniqueGames = Array.from(allGamesMap.values());

        // We only actively farm games that have > 0 drops
        let farmable = uniqueGames.filter(g => g.remaining_drops > 0);
        
        if (this.settings.ignore_comp !== false) {
            const compIds = [730, 570, 440, 578080, 252490, 271590, 1172470];
            const beforeCount = farmable.length;
            farmable = farmable.filter(g => !compIds.includes(g.app_id));
            const removed = beforeCount - farmable.length;
            if (removed > 0) {
                this.log(`🛡 Güvenlik Filtresi (VAC Secure): ${removed} rekabetçi oyun listeden çıkarıldı.`, "info");
            }
        }
        
        this.gamesToFarm = farmable;
        this.updateTotalDrops();
        
        this.log(`🎮 Doğrulanan ${uniqueGames.length} oyun içinden kart düşecek oyun: ${this.gamesToFarm.length}. Toplam: ${this.totalRemainingDrops} kart.`, "info");
        return uniqueGames;
    }

    _fetchOwnedGames() {
        return new Promise((resolve, reject) => {
            this.community.httpRequest('https://steamcommunity.com/my/games/?tab=all', (err, res, body) => {
                if (err) return reject(err);
                
                fs.writeFileSync('steam_games.html', body); // optional debug
                
                const games = [];
                // Look for Steam's new React SSR data payload
                const ssrMatch = body.match(/window\.SSR\.renderContext\s*=\s*JSON\.parse\(\s*"(.*?)"\s*\);/);
                if (ssrMatch && ssrMatch[1]) {
                    try {
                        const unescaped = ssrMatch[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
                        const renderContext = JSON.parse(unescaped);
                        
                        if (renderContext.queryData) {
                            const queryData = typeof renderContext.queryData === 'string' 
                                ? JSON.parse(renderContext.queryData) 
                                : renderContext.queryData;
                                
                            const ownedGamesQuery = queryData.queries.find(q => q.queryKey && q.queryKey[0] === 'OwnedGames');
                            if (ownedGamesQuery && ownedGamesQuery.state.data) {
                                const parsedGames = ownedGamesQuery.state.data;
                                parsedGames.forEach(g => {
                                    games.push({
                                        app_id: g.appid,
                                        name: g.name,
                                        remaining_drops: 0,
                                        playtime_min: g.playtime_forever ? Math.floor(g.playtime_forever) : 0,
                                        needs_playtime_hack: (g.playtime_forever ? Math.floor(g.playtime_forever) : 0) < 120,
                                        image_url: `https://steamcdn-a.akamaihd.net/steam/apps/${g.appid}/capsule_184x69.jpg`
                                    });
                                });
                            }
                        }
                    } catch(e) {
                        this.log(`⚠ Oyun listesi (React State) JSON parçalama hatası: ${e.message}`, "warning");
                    }
                } else {
                    // Fallback to legacy layout if available
                    const match = body.match(/var\s+rgGames\s*=\s*(\[.*?\]);/s);
                    if (match && match[1]) {
                        try {
                            const parsed = JSON.parse(match[1]);
                            parsed.forEach(g => {
                                games.push({
                                    app_id: g.appid,
                                    name: g.name,
                                    remaining_drops: 0,
                                    playtime_min: g.hours_forever ? Math.floor(parseFloat(g.hours_forever.replace(',', '')) * 60) : 0,
                                    needs_playtime_hack: (g.hours_forever ? Math.floor(parseFloat(g.hours_forever.replace(',', '')) * 60) : 0) < 120,
                                    image_url: g.logo ? `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${g.appid}/${g.logo}.jpg` : `https://steamcdn-a.akamaihd.net/steam/apps/${g.appid}/capsule_184x69.jpg`
                                });
                            });
                        } catch (e) {
                            this.log(`⚠ Eski arayüz rgGames JSON parse error`, "warning");
                        }
                    }
                }
                resolve(games);
            });
        });
    }

    _fetchBadgesPage(page) {
        return new Promise((resolve, reject) => {
            this.community.httpRequest(`https://steamcommunity.com/my/badges/?p=${page}`, (err, res, body) => {
                if (err) return reject(err);

                fs.writeFileSync(`steam_badges_p${page}.html`, body);

                const $ = cheerio.load(body);
                const games = [];

                let maxPage = page;
                $('.pageLinks a.pagelink').each((i, el) => {
                    const pNum = parseInt($(el).text().trim());
                    if (!isNaN(pNum) && pNum > maxPage) maxPage = pNum;
                });

                $('.badge_row.is_link').each((i, el) => {
                    const row = $(el);
                    
                    const href = row.find('a.badge_row_overlay').attr('href');
                    if (!href) return;
                    
                    const idMatch = href.match(/\/gamecards\/(\d+)/);
                    if (!idMatch) return;
                    
                    const appId = parseInt(idMatch[1]);
                    
                    // Filter out common steam events by AppID or link structure (events often don't have standard game appids, but some do).
                    // Actually, ASF filters by checking if the badge has a "playtime" stat or if it explicitly says "X card drops remaining".
                    const progressEl = row.find('.progress_info_bold').text().toLowerCase();
                    
                    // Check if it's a valid game drop badge. Some say "No card drops remaining" or "X card drops remaining" or Turkish equivalents.
                    let remaining = 0;
                    const dropMatchEn = progressEl.match(/(\d+)\s+card drop/);
                    const dropMatchTr = progressEl.match(/(\d+)\s+kart/);
                    
                    // If it has NO mention of drops, it's either an event or fully completed.
                    const isCompletedEn = progressEl.includes("no card drops");
                    const isCompletedTr = progressEl.includes("kalmad");

                    if (dropMatchEn) {
                        remaining = parseInt(dropMatchEn[1]);
                    } else if (dropMatchTr) {
                        remaining = parseInt(dropMatchTr[1]);
                    } else if (!isCompletedEn && !isCompletedTr) {
                        // If it doesn't mention drops remaining AND doesn't mention "no drops", it's likely an event badge or foil badge.
                        return;
                    }

                    // Strict check against known event AppIDs (Winter Sale, Summer Sale etc usually have AppIDs like 3369400, 3010300, etc but it's safer to filter by playtime presence)
                    // If a game has 0 playtime, the '.badge_title_stats_playtime' might be missing OR empty. We shouldn't strictly require it, otherwise unplayed games won't show.
                    
                    let name = row.find('.badge_title').text().trim().split('\xa0')[0];
                    if (!name) name = `App ${appId}`;
                    
                    // Hard filter event keywords just in case
                    if (name.toLowerCase().includes('sale') || name.toLowerCase().includes('fest') || name.toLowerCase().includes('ödülleri')) {
                        return;
                    }

                    let playtimeMin = 0;
                    const ptEl = row.find('.badge_title_stats_playtime').text().trim();
                    const ptMatchEn = ptEl.match(/([\d,.]+)\s+hrs/);
                    const ptMatchTr = ptEl.match(/([\d,.]+)\s+saat/);
                    
                    if (ptMatchEn) {
                        playtimeMin = Math.floor(parseFloat(ptMatchEn[1].replace(',', '')) * 60);
                    } else if (ptMatchTr) {
                        playtimeMin = Math.floor(parseFloat(ptMatchTr[1].replace(',', '.')) * 60);
                    }

                    const imageUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/capsule_184x69.jpg`;

                    games.push({
                        app_id: appId,
                        name: name,
                        remaining_drops: remaining,
                        playtime_min: playtimeMin,
                        needs_playtime_hack: playtimeMin < 120,
                        image_url: imageUrl
                    });
                });

                resolve({ games, maxPage });
            });
        });
    }

    async _refreshDrops(appId) {
        return new Promise((resolve) => {
            this.community.httpRequest(`https://steamcommunity.com/my/gamecards/${appId}/?t=${Date.now()}`, (err, res, body) => {
                if (err) return resolve(-1);
                const $ = cheerio.load(body);
                const progressEl = $('.progress_info_bold').text();
                // Match English: "X card drops remaining" or Turkish: "X kart düşürme hakkınız kaldı"
                const mEn = progressEl.match(/(\d+)\s+card drop/);
                const mTr = progressEl.match(/(\d+)\s+kart/);
                if (mEn) {
                    resolve(parseInt(mEn[1]));
                } else if (mTr) {
                    resolve(parseInt(mTr[1]));
                } else {
                    resolve(0);
                }
            });
        });
    }

    // A simple awaitable delay
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startFarming(appIds = null) {
        this.farming = true;
        try {
            let games = await this.getGamesWithDrops();
            
            // Only allow farming games that actually have card drops
            games = games.filter(g => g.remaining_drops > 0);

            if (appIds && Array.isArray(appIds) && appIds.length > 0) {
                // Ensure comparing integers with integers
                const idArr = appIds.map(id => parseInt(id));
                games = games.filter(g => idArr.includes(g.app_id));
            }

            if (!games || games.length === 0) {
                this.log("ℹ Kart düşecek oyun yok veya seçim yapılmadı.", "info");
                this.farming = false;
                return;
            }

            this.log(`🚀 ${games.length} oyun sıraya alındı.`);
            
            // 1. Evaluate: Needs Playtime Hack (<120 min) vs Ready (>120 min)
            let needsHack = games.filter(g => g.needs_playtime_hack);
            let ready = games.filter(g => !g.needs_playtime_hack);

            // 2. Playtime Hack in batches
            if (needsHack.length > 0) {
                this.log(`⏳ ${needsHack.length} oyunun 2 saati (120dk) doldurması gerekiyor. Çoklu başlatılıyor...`, "warning");
                
                const limit = parseInt(this.settings.limit, 10) || 1;
                for (let i = 0; i < needsHack.length; i += limit) {
                    if (!this.farming) break;
                    
                    const batch = needsHack.slice(i, i + limit);
                    this.log(`-- 🕒 Grup [${Math.floor(i/limit) + 1}] (${batch.length} oyun) 2 saate tamamlanıyor... --`, "info");
                    
                    await this.idleBatch(batch);
                    ready.push(...batch);
                }
            }

            // 3. Card Drops (Solo or Batch)
            if (ready.length > 0 && this.farming) {
                this.log(`🃏 ${ready.length} oyun kart düşürmek için tam anlamıyla hazır!`, "info");
                
                if (this.settings.solo) {
                    this.log("⚡ Solo Mod Aktif: Oyunlar tek tek çalıştırılarak kartların anında düşmesi sağlanacak.", "success");
                    for (let i = 0; i < ready.length; i++) {
                        if (!this.farming) break;
                        const g = ready[i];
                        this.log(`── [${i+1}/${ready.length}] ${g.name} (${g.remaining_drops} kart) ──`);
                        await this.idleGameSolo(g);
                    }
                } else {
                    this.log("🐌 Solo Mod Kapalı: Oyunlar gruplar halinde çalıştırılacak (Hızlı düşüş garanti edilmez).", "warning");
                    const limit = parseInt(this.settings.limit, 10) || 1;
                    for (let i = 0; i < ready.length; i += limit) {
                        if (!this.farming) break;
                        const batch = ready.slice(i, i + limit);
                        this.log(`── Grup [${Math.floor(i/limit) + 1}] Kart Düşürme Başladı (${batch.length} oyun) ──`);
                        await this.idleGameBatch(batch);
                    }
                }
            }

            if (this.farming) {
                this.log("🏁 Bütün oyunların işlemi başarıyla sonlandı!", "success");
            }
        } catch (e) {
            this.log(`❌ Hata: ${e.message}`, "error");
            console.error(e);
        } finally {
            this.farming = false;
            this.currentGames = [];
            this.client.gamesPlayed([]);
        }
    }

    async idleBatch(games) {
        this.currentGames = games;
        const appIds = games.map(g => g.app_id);
        this.client.gamesPlayed(appIds);
        
        let maxNeededMin = 0;
        games.forEach(g => {
            const needed = Math.max(0, 120 - g.playtime_min);
            if (needed > maxNeededMin) maxNeededMin = needed;
        });

        this.log(`⏱ Maksimum gruba bekleme süresi: ~${maxNeededMin} dk`);
        
        for (let m = 0; m < maxNeededMin; m++) {
            if (!this.farming) return;
            await this.sleep(60000);
            this.stats.total_playtime_min += games.length;
            
            if (m > 0 && m % 1 === 0) {
                this.log(`⏱ ${m}/${maxNeededMin} dk toplu sahte oynama tamamlandı...`);
            }
        }
    }

    _recordDropHistory(count) {
        if (!count || count <= 0) return;
        try {
            const histPath = require('path').join(__dirname, 'history.json');
            let hist = {};
            if (fs.existsSync(histPath)) {
                hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
            }
            // format YYYY-MM-DD local time
            const d = new Date();
            const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            
            if (!hist[dateStr]) hist[dateStr] = 0;
            hist[dateStr] += count;
            fs.writeFileSync(histPath, JSON.stringify(hist, null, 2));
        } catch(e) {
            this.log(`⚠ İstatistik kaydedilemedi: ${e.message}`, 'warning');
        }
    }

    async idleGameSolo(game) {
        this.currentGames = [game];
        this.client.gamesPlayed([game.app_id]);
        this.log(`🕹 [${game.app_id}] ${game.name} başlatıldı.`, "info");

        let remaining = game.remaining_drops;
        const checkIntervalMs = 5 * 60 * 1000;

        while (remaining > 0 && this.farming) {
            this.log(`⌛ ${game.name}: ${remaining} kart bekleniyor (5 dk veya kart düşüşü).`);
            this._newItemsReceived = false;
            
            let waited = 0;
            while (waited < checkIntervalMs) {
                if (!this.farming) return;
                if (this._newItemsReceived) {
                    this._newItemsReceived = false;
                    this.log(`⚡ ${game.name}: Kart düşme sinyali alındı, rozet sayfası bekleniyor...`, "info");
                    await this.sleep(8000); // 8 sn bekle, Steam'in badge sayfasını güncellemesi için
                    break;
                }
                await this.sleep(5000);
                waited += 5000;
            }

            this.stats.total_playtime_min += Math.round(waited / 60000);

            const newR = await this._refreshDrops(game.app_id);
            if (newR === -1) {
                this.log(`⚠ ${game.name}: sayfa okunamadı, tekrar deneniyor...`, "warning");
                continue;
            }

            const dropped = remaining - newR;
            if (dropped > 0) {
                this.stats.cards_dropped += dropped;
                this._recordDropHistory(dropped);
                game.remaining_drops = newR;
                this.updateTotalDrops();
                this.log(`🃏 ${game.name}: ${dropped} kart düştü! (${newR} kaldı)`, "success");
            }
            remaining = newR;
        }

        if (this.farming) {
            game.remaining_drops = 0;
            this.updateTotalDrops();
            this.log(`✅ ${game.name}: tamamlandı!`, "success");
            this.stats.games_completed += 1;
        }
        
        this.currentGame = null;
    }

    async idleGameBatch(batch) {
        this.currentGames = batch;
        const appIds = batch.map(g => g.app_id);
        this.client.gamesPlayed(appIds);
        
        let activeGames = [...batch];
        const checkIntervalMs = 15 * 60 * 1000; 

        while (activeGames.length > 0 && this.farming) {
            this.log(`⌛ ${activeGames.length} oyun için kart bekleniyor (15 dk veya kart düşüşü)...`);
            this._newItemsReceived = false;
            
            let waited = 0;
            while (waited < checkIntervalMs) {
                if (!this.farming) return;
                if (this._newItemsReceived) {
                    this._newItemsReceived = false;
                    this.log(`⚡ Kart düşme sinyali alındı, rozet sayfası senkronizasyonu bekleniyor...`, "info");
                    await this.sleep(8000); // 8 saniye bekle - Steam sayfa önbelleğinin güncellenmesi için
                    break;
                }
                await this.sleep(5000);
                waited += 5000;
            }

            this.stats.total_playtime_min += Math.round((waited / 60000) * activeGames.length);

            for (let i = activeGames.length - 1; i >= 0; i--) {
                if (!this.farming) return;
                const g = activeGames[i];
                const newR = await this._refreshDrops(g.app_id);
                
                if (newR === -1) continue;
                
                const dropped = g.remaining_drops - newR;
                if (dropped > 0) {
                    this.stats.cards_dropped += dropped;
                    this._recordDropHistory(dropped);
                    g.remaining_drops = newR;
                    this.updateTotalDrops();
                    this.log(`🃏 ${g.name}: ${dropped} kart düştü! (${newR} kaldı)`, "success");
                }
                
                if (newR === 0) {
                    this.log(`✅ ${g.name}: tamamlandı!`, "success");
                    this.stats.games_completed += 1;
                    activeGames.splice(i, 1);
                    this.currentGames = activeGames;
                    this.client.gamesPlayed(activeGames.map(ag => ag.app_id));
                }
            }
        }
    }

    stop() {
        this.farming = false;
        if (this.client) {
            this.client.gamesPlayed([]);
        }
    }
}

module.exports = SteamCardFarmer;
