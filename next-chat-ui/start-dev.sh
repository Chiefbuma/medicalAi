#!/bin/sh
set -e
cp -n .env.example .env || true
npm install
npm run dev -- --hostname 0.0.0.0
