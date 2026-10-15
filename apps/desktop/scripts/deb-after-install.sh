#!/bin/bash
# Replaces electron-builder's default after-install template (see
# build.deb.afterInstall in package.json).
#
# The default probe (`unshare --user true`) runs as root during dpkg, where it
# succeeds even on systems that block unprivileged user namespaces (Ubuntu's
# kernel.apparmor_restrict_unprivileged_userns=1). It then left chrome-sandbox
# 0755, so every launch aborted with:
#   "The SUID sandbox helper binary was found, but is not configured correctly."
# Arm the helper unconditionally, like the Debian chromium package does:
# Chromium prefers the user-namespace sandbox when the kernel allows it and
# only falls back to this helper when it has to.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
