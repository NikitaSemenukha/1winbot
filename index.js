require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http');

// ==========================================
// 1️⃣ СЕРВЕР ДЛЯ RENDER (Health Check)
// ==========================================
// Этого блока НЕ БЫЛО в твоем старом коде, но он ОБЯЗАТЕЛЕН для Render.
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Telegram Bot is Active! 🚀');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Web Server started on port ${PORT}`);
});

// ==========================================
// 2️⃣ НАСТРОЙКИ
// ==========================================
const token = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const PARTNER_LINK = process.env.PARTNER_LINK;

if (!token || !MONGO_URI || !ADMIN_ID) {
    console.error('❌ ОШИБКА: Проверь .env файл (BOT_TOKEN, MONGO_URI, ADMIN_ID)');
}

// Подключение к БД
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB подключена'))
    .catch(err => console.error('❌ Ошибка БД:', err));

const userSchema = new mongoose.Schema({
    chatId: { type: Number, unique: true },
    username: String,
    firstName: String,
    joinedAt: { type: Date, default: Date.now },
    isBlocked: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const bot = new TelegramBot(token, { polling: true });

let adminState = { step: null };

// ==========================================
// 3️⃣ НАСТРОЙКА МЕНЮ
// ==========================================
async function setupCommands() {
    try {
        // Меню для всех
        await bot.setMyCommands([
            { command: '/start', description: '🏠 Главная' },
            { command: '/bonus', description: '🎁 Бонус' },
            { command: '/about', description: 'ℹ️ О боте' }
        ]);
        
        // Меню для АДМИНА
        await bot.setMyCommands([
            { command: '/start', description: '🏠 Главная' },
            { command: '/send', description: '📢 Рассылка' },
            { command: '/stats', description: '📊 Статистика' },
            { command: '/cancel', description: '❌ Отмена' }
        ], { scope: { type: 'chat', chat_id: ADMIN_ID } });

        console.log('✅ Меню обновлено');
    } catch (error) {
        console.error('Ошибка меню:', error.message);
    }
}
setupCommands();

// ==========================================
// 4️⃣ ЛОГИКА АДМИНА (Рассылка)
// ==========================================

bot.onText(/\/stats/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const total = await User.countDocuments();
    const blocked = await User.countDocuments({ isBlocked: true });
    bot.sendMessage(ADMIN_ID, `📊 <b>Статистика:</b>\n👥 Всего юзеров: ${total}\n💀 Блок: ${blocked}`, { parse_mode: 'HTML' });
});

bot.onText(/\/send/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState.step = 'WAITING_POST';
    bot.sendMessage(ADMIN_ID, '📢 <b>Режим рассылки</b>\nПерешли пост или напиши текст:', { parse_mode: 'HTML' });
});

bot.onText(/\/cancel/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState.step = null;
    bot.sendMessage(ADMIN_ID, '❌ Отмена.');
});

// ГЛАВНЫЙ ОБРАБОТЧИК (И Рассылка, и Сохранение юзеров)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Не реагируем на команды как на текст
    if (msg.text && msg.text.startsWith('/')) return;

    // --- ЛОГИКА РАССЫЛКИ ---
    if (chatId === ADMIN_ID && adminState.step === 'WAITING_POST') {
        const users = await User.find({ isBlocked: false });
        bot.sendMessage(ADMIN_ID, `⏳ Рассылаю на ${users.length} чел...`);
        adminState.step = null;

        let count = 0;
        for (const user of users) {
            try {
                await bot.copyMessage(user.chatId, ADMIN_ID, msg.message_id);
                count++;
            } catch (e) {
                if (e.response && e.response.statusCode === 403) {
                    await User.updateOne({ chatId: user.chatId }, { isBlocked: true });
                }
            }
            await new Promise(r => setTimeout(r, 50)); // Пауза от спама
        }
        return bot.sendMessage(ADMIN_ID, `✅ Рассылка завершена! Доставлено: ${count}`);
    }

    // --- ЛОГИКА СОХРАНЕНИЯ ЮЗЕРА ---
    // (Сохраняем любого, кто пишет боту, чтобы потом делать рассылку)
    try {
        await User.updateOne(
            { chatId }, 
            { $setOnInsert: { username: msg.from.username, firstName: msg.from.first_name }, isBlocked: false }, 
            { upsert: true }
        );
    } catch (e) { console.error(e); }
});

// ==========================================
// 5️⃣ ВОРОНКА (START FLOW)
// ==========================================

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await User.updateOne({ chatId }, { isBlocked: false, firstName: msg.from.first_name }, { upsert: true });

    bot.sendMessage(chatId, 
        `👋 <b>Привет!</b>\n\nЗдесь ты получишь доступ к приватному каналу с сигналами и бонусом.\n👇 Выбери страну:`, 
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🇷🇺 Россия', callback_data: 'geo_ru' }, { text: '🇺🇿 Узбекистан', callback_data: 'geo_uz' }],
                    [{ text: '🇰🇿 Казахстан', callback_data: 'geo_kz' }, { text: '🌍 Другая', callback_data: 'geo_other' }]
                ]
            }
        }
    );
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        if (data.startsWith('geo_')) {
            await bot.editMessageText('🔞 Тебе есть 18 лет?', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [[{ text: '✅ Да', callback_data: 'age_yes' }], [{ text: '❌ Нет', callback_data: 'age_no' }]]
                }
            });
        }
        else if (data === 'age_yes') {
            await bot.editMessageText('❓ Был ли ранее аккаунт в 1win?', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Да, был', callback_data: 'acc_yes' }], [{ text: 'Нет, новый', callback_data: 'acc_no' }]]
                }
            });
        }
        else if (data === 'age_no') {
            await bot.sendMessage(chatId, '⛔ Доступ только с 18 лет.');
        }
        else if (data === 'acc_yes') {
            await bot.sendMessage(chatId, '⚠️ Бонус работает только на НОВЫХ аккаунтах. Зарегистрируй новый!');
            sendFinalLink(chatId);
        }
        else if (data === 'acc_no') {
            await bot.sendMessage(chatId, '✅ Отлично! Аккаунт подходит.');
            sendFinalLink(chatId);
        }
    } catch (e) { console.error(e); }
});

function sendFinalLink(chatId) {
    bot.sendMessage(chatId, 
        `🎁 <b>Твой доступ готов!</b>\n\n1. Регистрируйся: <a href="${PARTNER_LINK}">ПЕРЕЙТИ В 1WIN</a>\n2. Жди сигналы здесь.`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
    );
}

// Доп. кнопки
bot.onText(/\/bonus/, (msg) => sendFinalLink(msg.chat.id));
bot.onText(/\/about/, (msg) => bot.sendMessage(msg.chat.id, '🤖 Бот работает на базе AI.'));

console.log('🤖 Бот запускается...');