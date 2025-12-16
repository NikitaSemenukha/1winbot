require('dotenv').config(); // Подключаем .env
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

// ==========================================
// ⚙️ НАСТРОЙКИ ИЗ .ENV
// ==========================================
const token = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
// Преобразуем ID админа в число, так как Telegram отдает chatId числом
const ADMIN_ID = parseInt(process.env.ADMIN_ID); 
const PARTNER_LINK = process.env.PARTNER_LINK;

if (!token || !MONGO_URI || !ADMIN_ID) {
    console.error('❌ ОШИБКА: Не заполнен файл .env');
    process.exit(1);
}

// Подключение к БД
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB подключена'))
    .catch(err => console.error('❌ Ошибка подключения БД:', err));

// Схема пользователя
const userSchema = new mongoose.Schema({
    chatId: { type: Number, unique: true },
    username: String,
    firstName: String,
    joinedAt: { type: Date, default: Date.now },
    isBlocked: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const bot = new TelegramBot(token, { polling: true });

// Состояние админа
let adminState = { step: null };

// ==========================================
// 🛠 НАСТРОЙКА КНОПКИ "МЕНЮ" (COMMANDS)
// ==========================================

async function setupCommands() {
    try {
        // 1. Меню для ВСЕХ пользователей
        const userCommands = [
            { command: '/start', description: '🏠 Перезапуск / Меню' },
            { command: '/bonus', description: '🎁 Забрать бонус 1win' },
            { command: '/about', description: 'ℹ️ О боте' }
        ];

        // Устанавливаем дефолтное меню
        await bot.setMyCommands(userCommands);

        // 2. Меню ЛИЧНО ДЛЯ АДМИНА (по твоему ID)
        // Добавляем сюда секретные команды
        const adminCommands = [
            { command: '/start', description: '🏠 Перезапуск' },
            { command: '/send', description: '📢 Создать рассылку' },
            { command: '/stats', description: '📊 Статистика юзеров' }, // Новая команда
            { command: '/cancel', description: '❌ Отменить действие' }
        ];

        // scope: { type: 'chat', chat_id: ADMIN_ID } — магия, которая показывает это только тебе
        await bot.setMyCommands(adminCommands, { 
            scope: { type: 'chat', chat_id: ADMIN_ID } 
        });

        console.log('✅ Командное меню настроено (Admin vs User)');
    } catch (error) {
        console.error('Ошибка настройки меню:', error);
    }
}

// Вызываем функцию настройки меню при старте
setupCommands();

// ==========================================
// 1️⃣ ЛОГИКА АДМИНА (РАССЫЛКА)
// ==========================================

// Команда /send
bot.onText(/\/send/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState.step = 'WAITING_POST';
    bot.sendMessage(ADMIN_ID, '📢 <b>Режим рассылки</b>\n\nПерешли мне пост или напиши текст. Я отправлю его всем.', { parse_mode: 'HTML' });
});

// Команда /cancel
bot.onText(/\/cancel/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState.step = null;
    bot.sendMessage(ADMIN_ID, '❌ Рассылка отменена.');
});

// ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Игнорируем команды, чтобы они не попадали в рассылку или базу как обычный текст
    // (если сообщение начинается со слэша, мы выходим из этой функции, так как сработает onText)
    if (msg.text && msg.text.startsWith('/')) return;

    // --- БЛОК АДМИНА (РАССЫЛКА) ---
    if (chatId === ADMIN_ID && adminState.step === 'WAITING_POST') {
        const users = await User.find({ isBlocked: false });
        
        if (users.length === 0) {
            bot.sendMessage(ADMIN_ID, '🤷‍♂️ В базе пока нет пользователей.');
            adminState.step = null;
            return;
        }

        bot.sendMessage(ADMIN_ID, `⏳ Начинаю рассылку на ${users.length} юзеров...`);
        adminState.step = null; // Сбрасываем режим, чтобы не зациклило

        let success = 0;
        let blocked = 0;

        for (const user of users) {
            try {
                // Копируем сообщение (текст, фото, видео, кружочки)
                await bot.copyMessage(user.chatId, ADMIN_ID, msg.message_id);
                success++;
            } catch (error) {
                // Ошибка 403 - юзер заблочил бота
                if (error.response && error.response.statusCode === 403) {
                    blocked++;
                    await User.updateOne({ chatId: user.chatId }, { isBlocked: true });
                } else {
                    console.error(`Ошибка отправки юзеру ${user.chatId}:`, error.message);
                }
            }
            // Задержка 50мс (20 сообщений в секунду - лимит Телеграм)
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return bot.sendMessage(ADMIN_ID, 
            `✅ <b>Рассылка завершена!</b>\n\n` +
            `📨 Доставлено: ${success}\n` +
            `💀 Бот заблокирован: ${blocked}`, 
            { parse_mode: 'HTML' }
        );
    }

    // --- БЛОК ОБЫЧНОГО ПОЛЬЗОВАТЕЛЯ ---
    // Сохраняем всех, кто пишет (даже если это админ, пусть будет в базе для тестов)
    try {
        await User.updateOne(
            { chatId: chatId }, 
            { 
                $setOnInsert: { 
                    username: msg.from.username, 
                    firstName: msg.from.first_name 
                },
                isBlocked: false 
            }, 
            { upsert: true }
        );
    } catch (e) {
        console.error('Ошибка записи в БД:', e);
    }
});

// ==========================================
// 2️⃣ ЛОГИКА ВОРОНКИ (START)
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    // При старте тоже обновляем/добавляем юзера в базу
    User.updateOne({ chatId }, { isBlocked: false, firstName: msg.from.first_name }, { upsert: true }).exec();

    bot.sendMessage(chatId, 
        `👋 <b>Привет!</b>\n\n` +
        `Получи доступ к VIP-сигналам 1win и бонусу.\n` +
        `Сначала ответь: Ты из какой страны?`, 
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
                    inline_keyboard: [
                        [{ text: '✅ Да', callback_data: 'age_yes' }],
                        [{ text: '❌ Нет', callback_data: 'age_no' }]
                    ]
                }
            });
        }
        else if (data === 'age_yes') {
            await bot.editMessageText('❓ Был ли ранее аккаунт в 1win?', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Да, был', callback_data: 'acc_yes' }],
                        [{ text: 'Нет, новый', callback_data: 'acc_no' }]
                    ]
                }
            });
        } 
        else if (data === 'age_no') {
            await bot.sendMessage(chatId, '❌ Доступ только с 18 лет.');
        }
        else if (data === 'acc_yes') {
            await bot.sendMessage(chatId, '⚠️ Бонус доступен только для новых игроков. Зарегистрируй новый аккаунт, чтобы получать сигналы.');
            sendFinalLink(chatId);
        } 
        else if (data === 'acc_no') {
            await bot.sendMessage(chatId, '✅ Отлично! Аккаунт подходит для сигналов.');
            sendFinalLink(chatId);
        }
    } catch (error) {
        console.error('Ошибка в кнопках:', error);
    }
});

function sendFinalLink(chatId) {
    bot.sendMessage(chatId, 
        `🎁 <b>Твой доступ готов!</b>\n\n` +
        `1. Регистрируйся: <a href="${PARTNER_LINK}">ПЕРЕЙТИ В 1WIN</a>\n` +
        `2. Жди уведомлений о матчах в этом боте.`,
        { 
            parse_mode: 'HTML',
            disable_web_page_preview: true
        }
    );
}

// Обработчик кнопки "О боте"
bot.onText(/\/about/, (msg) => {
    bot.sendMessage(msg.chat.id, '🤖 Это официальный бот с сигналами. Мы используем AI для прогнозирования матчей.');
});

// Обработчик кнопки "Бонус"
bot.onText(/\/bonus/, (msg) => {
    // Можно просто переслать на ту же логику, что и в конце воронки
    sendFinalLink(msg.chat.id);
});

// Обработчик статистики (ТОЛЬКО ДЛЯ АДМИНА)
bot.onText(/\/stats/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;

    // Считаем людей в базе
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isBlocked: false });
    const blockedUsers = await User.countDocuments({ isBlocked: true });

    bot.sendMessage(ADMIN_ID, 
        `📊 <b>Статистика бота:</b>\n\n` +
        `👥 Всего в базе: <b>${totalUsers}</b>\n` +
        `✅ Активные: <b>${activeUsers}</b>\n` +
        `💀 Заблокировали: <b>${blockedUsers}</b>`,
        { parse_mode: 'HTML' }
    );
});

console.log('🤖 Бот запущен...');