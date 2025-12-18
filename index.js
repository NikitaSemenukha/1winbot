require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http');

// ==========================================
// 1️⃣ СЕРВЕР ДЛЯ RENDER (Чтобы не засыпал)
// ==========================================
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bot is working! 🚀');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Web Server started on port ${PORT}`);
});

// ==========================================
// 2️⃣ НАСТРОЙКИ И БАЗА
// ==========================================
const token = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const SUPER_ADMIN_ID = parseInt(process.env.ADMIN_ID); // Главный админ из файла
const PARTNER_LINK = process.env.PARTNER_LINK;

if (!token || !MONGO_URI || !SUPER_ADMIN_ID) {
    console.error('❌ ОШИБКА: Проверь .env файл.');
    process.exit(1);
}

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB подключена'))
    .catch(err => console.error('❌ Ошибка БД:', err));

// Обновленная схема пользователя
const userSchema = new mongoose.Schema({
    chatId: { type: Number, unique: true },
    username: String,
    firstName: String,
    joinedAt: { type: Date, default: Date.now },
    isBlocked: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false }, // Флаг админа
    financialGoal: String // Выбранная цель ($)
});

const User = mongoose.model('User', userSchema);
const bot = new TelegramBot(token, { polling: true });

// Состояние для рассылки (храним отдельно для каждого админа)
const adminStates = {};

// ==========================================
// 3️⃣ ПРОВЕРКА НА АДМИНА
// ==========================================
async function checkAdmin(chatId) {
    if (chatId === SUPER_ADMIN_ID) return true; // Всегда да
    const user = await User.findOne({ chatId });
    return user && user.isAdmin;
}

// Настройка меню (вызывается при старте)
async function setupMenu() {
    try {
        await bot.setMyCommands([
            { command: '/start', description: '🔄 Перезапуск' },
            { command: '/bonus', description: '🎁 Фриспины' }
        ]);
        console.log('✅ Меню обновлено');
    } catch (e) { console.error(e); }
}
setupMenu();

// ==========================================
// 4️⃣ ЛОГИКА АДМИНКИ
// ==========================================

// Команда: Добавить админа (Только Супер-Админ)
// Пример: /addadmin 123456789
bot.onText(/\/addadmin (\d+)/, async (msg, match) => {
    if (msg.chat.id !== SUPER_ADMIN_ID) return;
    
    const newAdminId = parseInt(match[1]);
    await User.updateOne({ chatId: newAdminId }, { isAdmin: true }, { upsert: true });
    
    bot.sendMessage(SUPER_ADMIN_ID, `✅ Пользователь ${newAdminId} теперь администратор.`);
    bot.sendMessage(newAdminId, `👑 Вам выданы права администратора. Доступна команда /send.`);
});

// Команда: Статистика (Для всех админов)
bot.onText(/\/stats/, async (msg) => {
    if (!await checkAdmin(msg.chat.id)) return;

    const total = await User.countDocuments();
    const blocked = await User.countDocuments({ isBlocked: true });
    const admins = await User.countDocuments({ isAdmin: true });

    bot.sendMessage(msg.chat.id, 
        `📊 <b>Статистика:</b>\n` +
        `👥 Всего юзеров: ${total}\n` +
        `💀 Блок: ${blocked}\n` +
        `👑 Админов: ${admins}`, 
        { parse_mode: 'HTML' }
    );
});

// Команда: Рассылка
bot.onText(/\/send/, async (msg) => {
    if (!await checkAdmin(msg.chat.id)) return;
    adminStates[msg.chat.id] = 'WAITING_POST';
    bot.sendMessage(msg.chat.id, '📢 <b>Режим рассылки</b>\nПерешли пост или напиши текст:', { parse_mode: 'HTML' });
});

bot.onText(/\/cancel/, async (msg) => {
    if (!await checkAdmin(msg.chat.id)) return;
    adminStates[msg.chat.id] = null;
    bot.sendMessage(msg.chat.id, '❌ Отмена.');
});

// ==========================================
// 5️⃣ ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Игнорируем команды
    if (msg.text && msg.text.startsWith('/')) return;

    // --- ЛОГИКА РАССЫЛКИ ---
    if (await checkAdmin(chatId) && adminStates[chatId] === 'WAITING_POST') {
        const users = await User.find({ isBlocked: false });
        bot.sendMessage(chatId, `⏳ Рассылаю на ${users.length} чел...`);
        adminStates[chatId] = null;

        let count = 0;
        for (const user of users) {
            try {
                await bot.copyMessage(user.chatId, chatId, msg.message_id);
                count++;
            } catch (e) {
                if (e.response && e.response.statusCode === 403) {
                    await User.updateOne({ chatId: user.chatId }, { isBlocked: true });
                }
            }
            await new Promise(r => setTimeout(r, 40)); 
        }
        return bot.sendMessage(chatId, `✅ Рассылка завершена! Доставлено: ${count}`);
    }

    // --- СОХРАНЕНИЕ ЮЗЕРА ---
    try {
        await User.updateOne(
            { chatId }, 
            { $setOnInsert: { username: msg.from.username, firstName: msg.from.first_name } }, 
            { upsert: true }
        );
    } catch (e) {}
});

// ==========================================
// 6️⃣ НОВЫЙ СЦЕНАРИЙ (ВОРОНКА)
// ==========================================

// 1) Приветствие
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await User.updateOne({ chatId }, { isBlocked: false, firstName: msg.from.first_name }, { upsert: true });

    bot.sendMessage(chatId, 
        `👋 <b>Привет!</b>\n` +
        `Я — твой помощник по 1win: здесь ты можешь получить 500 фриспинов как стартовый бонус и полезную информацию о ставках.\n` +
        `Без обещаний — только информация и поддержка.`, 
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➡️ Начать', callback_data: 'start_flow' }]
                ]
            }
        }
    );
});

// Обработка кнопок
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    try {
        // 2) Фильтрация (Возраст)
        if (data === 'start_flow') {
            await bot.editMessageText(
                `📌 <b>Быстро уточню:</b>\nТебе есть 18 лет?`, 
                {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✔️ Да', callback_data: 'age_yes' }],
                            [{ text: '❌ Нет', callback_data: 'age_no' }]
                        ]
                    }
                }
            );
        }

        // Если Нет 18
        else if (data === 'age_no') {
            await bot.editMessageText(
                `К сожалению, бот предназначен только для взрослых.\n🔒 <b>Доступ ограничен.</b>`, 
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
            );
        }

        // 3) Финансовая цель
        else if (data === 'age_yes') {
            await bot.editMessageText(
                `💬 <b>Сколько ты хотел(а) бы зарабатывать в месяц?</b>`, 
                {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💵 500 $', callback_data: 'goal_500' }, { text: '💰 1 000 $', callback_data: 'goal_1000' }],
                            [{ text: '🔥 3 000 $', callback_data: 'goal_3000' }, { text: '🚀 5 000 $', callback_data: 'goal_5000' }]
                        ]
                    }
                }
            );
        }

        // 4) Финал (Ссылка)
        else if (data.startsWith('goal_')) {
            // Сохраняем цель в базу для аналитики
            const goalAmount = data.split('_')[1] + '$';
            await User.updateOne({ chatId }, { financialGoal: goalAmount });

            // Сначала удаляем кнопки у прошлого сообщения или пишем текст подтверждения
            await bot.editMessageText(
                `👍 <b>Принял.</b> Это цель, к которой можно стремиться.\n` +
                `Я помогу разобраться с платформой и бонусами 1win — а дальше всё зависит от твоих решений и подхода.`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
            );

            // Отправляем новое сообщение с ссылкой
            setTimeout(async () => {
                await bot.sendMessage(chatId,
                    `🔗 <b>Просто нажми на кнопку ниже —</b>\n` +
                    `это официальная ссылка с бонусом для новых игроков.`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '➡️ Получить 500 фриспинов в 1win', url: PARTNER_LINK }]
                            ]
                        }
                    }
                );
            }, 1000); // Небольшая задержка для естественности
        }

    } catch (e) {
        console.error('Ошибка в кнопках:', e.message);
    }
});

// Доп. команда для получения ссылки напрямую
bot.onText(/\/bonus/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `🎁 <a href="${PARTNER_LINK}">Получить 500 фриспинов</a>`, 
        { parse_mode: 'HTML', disable_web_page_preview: true }
    );
});

console.log('🤖 Бот запускается...');