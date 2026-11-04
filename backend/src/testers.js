// Ежедневное письмо тестировщикам закрытого теста Google Play (нужно 14 дней подряд).
// Настройки в Railway (адреса в репозиторий не кладём):
//   TESTERS_EMAILS  - почты через запятую
//   TESTERS_START   - дата первого дня теста, ГГГГ-ММ-ДД
//   TESTERS_HOUR_UTC - во сколько слать, по UTC (по умолчанию 13 = 19:00 Бишкек)
//   TESTERS_SIGN    - подпись (по умолчанию «Максим»)
import { query } from './db.js';

const TOTAL_DAYS = 14;
const PLAY_LINK = 'https://play.google.com/store/apps/details?id=online.forma2ko5.app';

const emails = () => String(process.env.TESTERS_EMAILS || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
const todayUtc = () => new Date().toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

export function testerDayInfo(day = todayUtc()) {
  const start = String(process.env.TESTERS_START || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const n = diffDays(start, day) + 1; // сегодняшний день теста
  if (n < 1 || n > TOTAL_DAYS) return null;
  return { n, left: TOTAL_DAYS - n };
}

export function testerMail(info) {
  const sign = process.env.TESTERS_SIGN || 'Максим';
  const { n, left } = info;
  const tail = left === 0
    ? 'Сегодня последний день теста - спасибо, что дошёл до конца! 🙌'
    : `До конца теста осталось дней: ${left}.`;
  return {
    subject: left === 0 ? 'Forma: последний день теста 🙌' : `Forma: день ${n} из ${TOTAL_DAYS}, осталось ${left}`,
    text: `Привет!\n\nЭто ${sign}, автор Forma. Спасибо, что помогаешь с тестом приложения в Google Play.\n\n` +
      `Чтобы Google пустил Forma в магазин, приложение должно быть установлено и открываться у 12 человек каждый день в течение 14 дней. ` +
      `Пожалуйста, зайди сегодня в Forma и запиши тренировку (или день отдыха) - это занимает минуту.\n\n` +
      `Сегодня день ${n} из ${TOTAL_DAYS}. ${tail}\n\n` +
      `Приложение: ${PLAY_LINK}\n\nЕсли что-то не работает - просто ответь на это письмо.\n\n${sign}`,
  };
}

async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('нет RESEND_API_KEY');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Forma <no-reply@forma2ko5.online>', to: [to], subject, text, reply_to: process.env.TESTERS_REPLY_TO || undefined }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
}

let ready;
async function sendTesters() {
  const list = emails();
  const hour = Number(process.env.TESTERS_HOUR_UTC ?? 13);
  if (!list.length || new Date().getUTCHours() < hour) return;
  const info = testerDayInfo();
  if (!info) return;
  ready ||= query('CREATE TABLE IF NOT EXISTS tester_mail_log (day DATE NOT NULL, email TEXT NOT NULL, PRIMARY KEY (day, email))');
  await ready;
  const day = todayUtc();
  const { subject, text } = testerMail(info);
  let sent = 0;
  for (const to of list) {
    // «занимаем» адрес на сегодня, чтобы при двух запусках не написать дважды
    const c = await query('INSERT INTO tester_mail_log (day, email) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING email', [day, to]);
    if (!c.rows.length) continue;
    try { await sendMail(to, subject, text); sent++; }
    catch (e) { console.error('Tester mail failed:', e.message); await query('DELETE FROM tester_mail_log WHERE day=$1 AND email=$2', [day, to]).catch(() => 0); }
    await new Promise((ok) => setTimeout(ok, 400));
  }
  if (sent) console.log(`Testers: отправлено ${sent}`);
}

export function startTestersScheduler() {
  const run = () => sendTesters().catch((e) => console.error('Testers failed:', e.message));
  setTimeout(run, 30000);
  setInterval(run, 10 * 60 * 1000);
}
