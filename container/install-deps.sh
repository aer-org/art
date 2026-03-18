#!/bin/bash
# Cross-distro package installer for Debian/Ubuntu variants.
# Handles package renames between Ubuntu 22.04 and 24.04+
# (e.g. libasound2 → libasound2t64, libtinfo5 removed).
set -euo pipefail

apt-get update

# install_one_of pkg1 pkg2 ... — install the first available package
install_one_of() {
    for pkg in "$@"; do
        if apt-cache show "$pkg" > /dev/null 2>&1; then
            apt-get install -y --no-install-recommends "$pkg"
            return 0
        fi
    done
    echo "WARNING: none of [$*] available, skipping" >&2
    return 0
}

# install_optional pkg — install if available, skip otherwise
install_optional() {
    for pkg in "$@"; do
        if apt-cache show "$pkg" > /dev/null 2>&1; then
            apt-get install -y --no-install-recommends "$pkg"
        else
            echo "NOTE: $pkg not available, skipping" >&2
        fi
    done
}

# --- Always-available packages ---
apt-get install -y --no-install-recommends \
    curl \
    git \
    locales \
    libc6-dev \
    binutils \
    fonts-liberation \
    libgbm1 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    gcc \
    g++ \
    coreutils

# --- Packages with distro-dependent names ---
install_one_of chromium chromium-browser
install_one_of libgtk-3-0t64 libgtk-3-0
install_one_of libatk-bridge2.0-0t64 libatk-bridge2.0-0
install_one_of libasound2t64 libasound2
install_one_of libtinfo6 libtinfo5
install_one_of libncurses6 libncurses5

# --- Optional packages (nice to have) ---
install_optional fonts-noto-cjk fonts-noto-color-emoji

# --- Locale setup ---
sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen
locale-gen

# --- Cleanup ---
rm -rf /var/lib/apt/lists/*
