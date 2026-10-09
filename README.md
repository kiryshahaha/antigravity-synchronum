# Synchronum 🔄

> Cross-device conversation & artifact synchronization for Google Antigravity 2.0 with Zero-Knowledge E2EE.

Синхронизация сессий, контекста и артефактов Google Antigravity 2.0 между устройствами (ПК, ноутбук) без сторонних серверов — на базе защищенного хранилища Google Диска (`appDataFolder`) и сквозного шифрования (AES-256-GCM).

---

## 🚀 Основные возможности

* **Zero-Server / Zero-Cost**: Никаких сторонних серверов, хостинга или платных баз данных. Используется системная квота Google Диска (2–5+ ТБ у пользователей Antigravity Pro).
* **Zero-Knowledge E2EE**: Все диалоги, мысли агента и артефакты шифруются ключом Argon2id + AES-256-GCM перед отправкой в облако.
* **Кроссплатформенная трансляция путей (Path Translation Engine)**: Автоматическая адаптация путей воркспейсов при переходе между ОС (Windows, macOS, Linux) по `git remote` и сопоставлению каталогов.
* **Нативная интеграция**: Оформление как расширение (Sidecar) с панелью мониторинга в Auxiliary Pane и реакцией на системные хуки (`hooks.json`).
* **Бесконфликтный SQLite движок**: Безопасный экспорт/импорт с предварительным вызовом `PRAGMA wal_checkpoint(TRUNCATE)` и транзакционным `UPSERT`.

---

## 📑 Документация

Подробная архитектура, описание форматов данных, криптографии и план разработки описаны в [Техническом задании (SPECIFICATION.md)](./SPECIFICATION.md).

---

## 🛠️ Стек технологий

* **Ядро & Sidecar**: TypeScript / Node.js
* **Локальные базы данных**: SQLite3 / better-sqlite3
* **Криптография**: Argon2id + AES-256-GCM
* **Облачный транспорт**: Google Drive v3 REST API (OAuth 2.0 PKCE Loopback)
* **Интерфейс**: React, Tailwind CSS (Antigravity Auxiliary Pane)

---

## 📄 Лицензия

MIT License © 2026
