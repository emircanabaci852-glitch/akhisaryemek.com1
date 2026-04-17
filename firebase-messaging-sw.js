// akhisaryemek.com Service Worker
// Sekme kapalıyken Firebase Realtime Database'i dinleyip bildirim gösterir

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js');

const firebaseConfig = {
    apiKey:            "AIzaSyDd8m7RL6Vi5SoRyK_fnOhmEhKNzoEmUMA",
    authDomain:        "akhisaryemek-583fd.firebaseapp.com",
    databaseURL:       "https://akhisaryemek-583fd-default-rtdb.europe-west1.firebasedatabase.app",
    projectId:         "akhisaryemek-583fd",
    storageBucket:     "akhisaryemek-583fd.firebasestorage.app",
    messagingSenderId: "702342527225",
    appId:             "1:702342527225:web:d9cb41ed212d1516368a28"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Son bildirim zamanı (spam önlemek için)
let lastNotifiedOrderIds = new Set();
let userProfile = null; // { uid, role, email, restaurantId }

// Service Worker kurulunca
self.addEventListener('install', (e) => {
    console.log('[SW] Installed');
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('[SW] Activated');
    e.waitUntil(self.clients.claim());
});

// Ana sayfadan kullanıcı bilgisi gelince dinlemeye başla
self.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SET_USER') {
        userProfile = e.data.user;
        console.log('[SW] User set:', userProfile?.role, userProfile?.email);
        startListeningForOrders();
    }
    if (e.data && e.data.type === 'CLEAR_USER') {
        userProfile = null;
        lastNotifiedOrderIds.clear();
    }
});

let _ordersRef = null;

function startListeningForOrders() {
    if (!userProfile) return;
    if (_ordersRef) {
        try { _ordersRef.off(); } catch(e) {}
    }
    _ordersRef = db.ref('orders');

    // İlk yüklemede mevcut siparişleri "bildirilmiş" say, yenileri yakala
    _ordersRef.once('value').then(snap => {
        const val = snap.val() || {};
        Object.values(val).forEach(o => lastNotifiedOrderIds.add(o.id));

        // Şimdi dinlemeye başla
        _ordersRef.on('child_added', handleNewOrder);
        _ordersRef.on('child_changed', handleOrderChange);
    });
}

function handleNewOrder(snap) {
    const o = snap.val();
    if (!o || lastNotifiedOrderIds.has(o.id)) return;
    lastNotifiedOrderIds.add(o.id);

    const u = userProfile;
    if (!u) return;

    // Admin: tüm yeni siparişler
    if (u.role === 'admin') {
        showNotification(
            `🔥 Yeni sipariş! #${o.id}`,
            `${o.restaurantName} · ${o.total.toFixed(0)}₺ · ${o.name}`,
            { orderId: o.id, url: '/' }
        );
        return;
    }

    // Restoran sahibi: sadece kendi restoranına gelen siparişler
    if (u.role === 'restaurant' && u.restaurantId === o.restaurantId) {
        showNotification(
            `🔥 Yeni sipariş! #${o.id}`,
            `${(o.icons||[]).join(' ')} ${o.items.slice(0,3).join(', ')} · ${o.total.toFixed(0)}₺`,
            { orderId: o.id, url: '/' }
        );
        return;
    }

    // Müşteri: kendi siparişi için onay bildirimi
    if (u.role === 'customer' && (o.customerId === u.uid || o.customerEmail === u.email)) {
        showNotification(
            `✅ Siparişiniz alındı! #${o.id}`,
            `${o.restaurantName} sipariş hazırlanmaya başlıyor...`,
            { orderId: o.id, url: '/' }
        );
    }
}

function handleOrderChange(snap) {
    const o = snap.val();
    if (!o) return;
    const u = userProfile;
    if (!u) return;

    // Kurye: sipariş kendisine atandıysa
    if (u.role === 'courier' && o.courierId === u.uid) {
        const key = `courier-assigned-${o.id}`;
        if (!lastNotifiedOrderIds.has(key)) {
            lastNotifiedOrderIds.add(key);
            showNotification(
                `🛵 Yeni teslimat! #${o.id}`,
                `${o.restaurantName} → ${o.address || 'adres yok'} · ${o.total.toFixed(0)}₺`,
                { orderId: o.id, url: '/' }
            );
        }
    }

    // Müşteri: sipariş durumu değişti (hazırlanıyor → yolda → teslim edildi)
    if (u.role === 'customer' && (o.customerId === u.uid || o.customerEmail === u.email)) {
        const statusKey = `status-${o.id}-${o.status}`;
        if (!lastNotifiedOrderIds.has(statusKey)) {
            lastNotifiedOrderIds.add(statusKey);
            let title = '', body = '';
            if (o.status === 'yolda') {
                title = `🛵 Siparişiniz yolda! #${o.id}`;
                body = `${o.restaurantName} · Kurye: ${o.courierName || 'atandı'}. 15-25 dk içinde kapınızda!`;
            } else if (o.status === 'teslim edildi') {
                title = `🎉 Siparişiniz teslim edildi! #${o.id}`;
                body = `${o.restaurantName} · Afiyet olsun! Değerlendirmeyi unutmayın ⭐`;
            } else if (o.status === 'hazırlanıyor' && o.scheduledAt) {
                title = `🍳 Planlanmış siparişiniz hazırlanıyor! #${o.id}`;
                body = `${o.restaurantName} siparişinizi hazırlıyor.`;
            }
            if (title) {
                showNotification(title, body, { orderId: o.id, url: '/' });
            }
        }
    }

    // Restoran sahibi: siparişi beklemededen hazırlanıyora düştüğünde
    if (u.role === 'restaurant' && u.restaurantId === o.restaurantId && o.status === 'hazırlanıyor' && o.scheduledAt) {
        const key = `scheduled-ready-${o.id}`;
        if (!lastNotifiedOrderIds.has(key)) {
            lastNotifiedOrderIds.add(key);
            showNotification(
                `⏰ Planlanmış sipariş hazırlanmalı! #${o.id}`,
                `${(o.icons||[]).join(' ')} ${o.items.slice(0,3).join(', ')}`,
                { orderId: o.id, url: '/' }
            );
        }
    }
}

function showNotification(title, body, data = {}) {
    const options = {
        body,
        icon: 'https://emojicdn.elk.sh/%F0%9F%8D%BD%EF%B8%8F?style=apple',
        badge: 'https://emojicdn.elk.sh/%F0%9F%8D%BD%EF%B8%8F?style=apple',
        tag: `aky-${data.orderId || Date.now()}`,
        requireInteraction: false,
        vibrate: [200, 100, 200],
        data
    };
    self.registration.showNotification(title, options);
}

// Bildirime tıklayınca siteyi aç
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = e.notification.data?.url || '/';
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Açık sekme varsa odaklan
            for (const client of windowClients) {
                if (client.url.includes(self.registration.scope) && 'focus' in client) {
                    return client.focus();
                }
            }
            // Yoksa yeni aç
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});
