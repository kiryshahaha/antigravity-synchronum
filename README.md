# Synchronum 🔄

> Cross-device conversation, artifact & brain synchronization for **Google Antigravity 2.0** with Zero-Knowledge E2EE.

Синхронизация сессий, контекста и сгенерированных артефактов Antigravity 2.0 между устройствами (ПК, ноутбук) без сторонних серверов — на базе защищенного системного раздела Google Диска (`appDataFolder`) и сквозного шифрования (AES-256-GCM).

---

## ✨ Возможности

* 🚀 **Zero-Server / Zero-Cost**: Никаких сторонних серверов или баз данных. Используется системная квота Google Диска (2–5+ ТБ у пользователей Antigravity Pro).
* 🔒 **Zero-Knowledge E2EE**: Все диалоги, мысли агента и артефакты шифруются ключом Argon2id + AES-256-GCM перед отправкой в облако.
* 🖥️ **Кроссплатформенная трансляция путей (Path Translation Engine)**: Автоматическая адаптация путей воркспейсов при переходе между ОС (Windows, macOS, Linux) по `git remote` и сопоставлению каталогов.
* 🧩 **Нативная интеграция с Antigravity**:
  * Оформление в виде расширения **Sidecar** с интерактивным дашбордом во вспомогательной панели (**Auxiliary Pane**).
  * Автоматический сброс WAL и триггеры через жизненные циклы `hooks.json` (событие `Stop`).
* 📦 **Бесконфликтный SQLite движок**: Безопасный экспорт/импорт с вызовом `PRAGMA wal_checkpoint(TRUNCATE)` и транзакционным `UPSERT`.

---

## 🛠️ Быстрый старт (CLI)

### 1. Установка
```bash
git clone https://github.com/kiryshahaha/antigravity-synchronum.git
cd antigravity-synchronum
npm install
npm run build
```

### 2. Проверка статуса Antigravity
```bash
node --experimental-sqlite ./dist/cli.js status
```
*Выведет статус подключения к локальной базе Antigravity и количество проиндексированных сессий.*

### 3. Просмотр локальных сессий
```bash
node --experimental-sqlite ./dist/cli.js list --limit 10
```

### 4. Экспорт и импорт одной сессии (Офлайн / Файл)
```bash
# Экспорт с шифрованием мастер-паролем:
node --experimental-sqlite ./dist/cli.js export <conversation-id> -p "MyMasterPassword" -o backup.bundle.enc

# Просмотр метаданных бандла:
node --experimental-sqlite ./dist/cli.js inspect backup.bundle.enc -p "MyMasterPassword"

# Импорт на другом компьютере:
node --experimental-sqlite ./dist/cli.js import backup.bundle.enc -p "MyMasterPassword"
```

---

## ☁️ Облачная синхронизация (Google Drive)

### 1. Авторизация через Google OAuth 2.0 (PKCE)
```bash
node --experimental-sqlite ./dist/cli.js login
```
*Откроет браузер для предоставления доступа к изолированной системной папке `appDataFolder` Google Диска (приложение не видит личные файлы на Диске).*

### 2. Выгрузка сессии в облако
```bash
node --experimental-sqlite ./dist/cli.js push <conversation-id> -p "MyMasterPassword"
```

### 3. Получение и восстановление на втором устройстве
```bash
node --experimental-sqlite ./dist/cli.js pull -p "MyMasterPassword"
```

---

## 🧩 Подключение в качестве Antigravity Sidecar

Чтобы дашборд Synchronum отображался прямо в правой панели Antigravity (Auxiliary Pane):

1. Скопируйте папку `sidecar/` в вашу директорию конфигурации Antigravity:
   * **Windows**: `~/.gemini/antigravity/sidecars/synchronum/`
   * **macOS / Linux**: `~/.gemini/antigravity/sidecars/synchronum/`
2. Перезапустите Antigravity 2.0.
3. В правом меню появится вкладка **Synchronum Cloud Sync**.

---

## 📑 Архитектура и спецификация

Подробное техническое описание схем баз данных, форматов бандлов и протоколов описано в [SPECIFICATION.md](./SPECIFICATION.md).

---

## 📄 Лицензия

MIT License © 2026 kiryshahaha
