# Synchronum 🔄

> Cross-device conversation, artifact & non-git workspace synchronization for **Google Antigravity 2.0** with Zero-Knowledge E2EE.

Синхронизация сессий диалогов, контекста, мыслей агента, артефактов и даже не привязанных к Git проектов Antigravity 2.0 между устройствами (ПК, ноутбук) без сторонних серверов — на базе защищенного системного раздела Google Диска (`appDataFolder`) или локальной расшаренной папки и сквозного шифрования (AES-256-GCM + Scrypt).

---

## ✨ Возможности v1.0.0

* 🚀 **Zero-Server / Zero-Cost**: Никаких сторонних серверов или баз данных. Используется защищенная системная квота Google Диска (`appDataFolder`, 2–5+ ТБ у пользователей Antigravity Pro) или локальная папка (Syncthing / Общий диск).
* 🔒 **Zero-Knowledge E2EE**: Все диалоги, мысли агента, артефакты и архивы воркспейсов шифруются надежным ключом Scrypt + AES-256-GCM с контролем целостности.
* 📦 **Non-Git Workspace Sync**: Автоматическая упаковка проектов, не привязанных к Git (сжатие gzip, SHA-256 хэш-версионирование, умный игнор `node_modules`/`.git`/артефактов сборки и лимиты безопасности: пропуск одиночных файлов > 25 МБ, предупреждение при > 100 МБ).
* 🗑️ **Tombstone Sync (Безопасное удаление)**: Удаленные диалоги помечаются флагом `deleted` (Tombstone с временной меткой). Другие устройства не воскрешают удаленный диалог, а синхронно удаляют его у себя.
* 🖥️ **Кроссплатформенная трансляция путей (Path Translation Engine)**: Автоматическая адаптация путей воркспейсов при переходе между ОС (Windows, macOS, Linux) по `git remote` и сопоставлению каталогов.
* 🔄 **Двусторонняя авто-синхронизация (`sync` & `watch`)**: Фоновый демон отслеживает изменения локальной базы Antigravity и облачного индекса, мгновенно подтягивая новые и обновленные сессии.
* ⚡ **One-Command Setup**: Команда `synchronum setup` мгновенно регистрирует Sidecar-панель в Antigravity, настраивает провайдер хранилища и пароль шифрования.
* 🧩 **Нативная интеграция с Antigravity**:
  * Оформление в виде расширения **Sidecar** с интерактивным веб-дашбордом во вспомогательной панели (**Auxiliary Pane**).
  * Автоматический сброс WAL и триггеры через жизненные циклы `hooks.json` (событие `Stop`).
* 🧪 **100% Test Coverage**: Автоматизированные тесты на нативном `node:test` (E2EE шифрование, Path Resolver, Tombstones, Non-Git Workspace Sync) и кроссплатформенный GitHub Actions CI/CD (Ubuntu, macOS, Windows).

---

## 🚀 Быстрый старт за 1 минуту

### Установка и автоматическая настройка
```bash
git clone https://github.com/kiryshahaha/antigravity-synchronum.git
cd antigravity-synchronum
npm install
npm run build
```

Запустите интерактивный сетап (или передайте параметры флагами):
```bash
node --experimental-sqlite ./dist/cli.js setup -p "MyMasterPassword" --storage gdrive
```

Команда `setup`:
1. Установит Sidecar Antigravity в `~/.gemini/antigravity/sidecars/synchronum/`.
2. Сохранит мастер-пароль и конфигурацию провайдера.
3. Проверит и восстановит целостность таблиц и WAL-файлов Antigravity.
4. Добавит ярлыки автозапуска демона (опционально с `--autostart`).

---

## 🛠️ Основные команды CLI

### 1. Проверка статуса
```bash
node --experimental-sqlite ./dist/cli.js status
```
Выведет статус подключения к локальной SQLite базе Antigravity, количество локальных сессий, удаленных диалогов и текущее состояние хранилища.

### 2. Список локальных сессий
```bash
node --experimental-sqlite ./dist/cli.js list --limit 10
```

### 3. Двусторонняя синхронизация (Two-Way Sync)
Синхронизирует сессии, воркспейсы и удаленные диалоги в обе стороны:
```bash
node --experimental-sqlite ./dist/cli.js sync -p "MyMasterPassword"
```

### 4. Фоновый автономный мониторинг (Watch Daemon)
Запускает непрерывный процесс, который слушает события Antigravity и изменения в облаке:
```bash
node --experimental-sqlite ./dist/cli.js watch -p "MyMasterPassword" --interval 30
```

### 5. Синхронизация не привязанных к Git воркспейсов
Упаковывает и синхронизирует проект без Git в облачный диск с SHA-256 хешированием:
```bash
node --experimental-sqlite ./dist/cli.js push-workspace /path/to/my-project -p "MyMasterPassword"
```
При запуске Antigravity на другом ПК проект распакуется автоматически, если локальный хэш отличается от облачного.

### 6. Удаление диалога (Tombstone)
Помечает сессию как удаленную, чтобы она не восстановилась со второго компьютера:
```bash
node --experimental-sqlite ./dist/cli.js delete <conversation-id> -p "MyMasterPassword"
```

### 7. Автономный экспорт и импорт в файл (Офлайн)
```bash
# Экспорт зашифрованного бандла:
node --experimental-sqlite ./dist/cli.js export <conversation-id> -p "MyMasterPassword" -o backup.bundle.enc

# Инспекция бандла без распаковки:
node --experimental-sqlite ./dist/cli.js inspect backup.bundle.enc -p "MyMasterPassword"

# Импорт бандла:
node --experimental-sqlite ./dist/cli.js import backup.bundle.enc -p "MyMasterPassword"
```

---

## ☁️ Провайдеры хранилища

### 1. Google Drive (`gdrive`)
Использует защищенную системную область `appDataFolder`. Никакие ваши личные файлы на Google Диске приложению не доступны.
```bash
node --experimental-sqlite ./dist/cli.js login
```

### 2. Локальная папка (`local`)
Идеально для пользователей Syncthing, Nextcloud, локальной сети или переносных дисков:
```bash
node --experimental-sqlite ./dist/cli.js setup --storage local --folder "D:/Sync/Antigravity" -p "MyMasterPassword"
```

---

## 🧪 Тестирование

Проект использует легковесный нативный раннер `node:test` (без внешних зависимостей типа Jest/Mocha):
```bash
npm test
```
Тесты проверяют:
* E2EE шифрование (AES-256-GCM + Scrypt roundtrip).
* Кроссплатформенный Path Resolver (Windows, POSIX, Git-remote).
* Модель Tombstones (бесконфликтное удаление).
* Упаковку, лимиты безопасности (>25MB skip, >100MB warning) и распаковку воркспейсов.

---

## 🧩 Antigravity Sidecar

После запуска `setup` панель **Synchronum Cloud Sync** автоматически доступна во вспомогательной панели Antigravity (Auxiliary Pane):
* Индикатор статуса синхронизации в реальном времени.
* Просмотр сессий, их статусов (Active / Synced / Deleted) и кнопок ручной синхронизации.
* Автоматический хук сброса WAL при закрытии программы (`hooks.json` -> event `Stop`).

---

## 📑 Архитектура и спецификация

Подробное техническое описание схемы БД, форматов бандлов и протоколов описано в [SPECIFICATION.md](./SPECIFICATION.md).

---

## 📄 Лицензия

MIT License © 2026 kiryshahaha
