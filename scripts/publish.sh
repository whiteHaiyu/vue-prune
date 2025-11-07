#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
用法: scripts/publish.sh [版本号|patch|minor|major|prerelease] [--tag <dist-tag>] [--dry]
示例:
  scripts/publish.sh patch                # 小版本号 + 发布（access: restricted）
  scripts/publish.sh minor --tag beta     # 次版本号 + 以 beta tag 发布
  scripts/publish.sh 0.2.0 --dry          # 仅试跑到发布（不真正发布）
EOF
}

BUMP=""
TAG=""
DRY_RUN=0

# 解析参数
ARGS=("$@")
I=0
while [ $I -lt ${#ARGS[@]} ]; do
  A="${ARGS[$I]}"
  case "$A" in
    -h|--help)
      usage; exit 0;;
    major|minor|patch|prerelease)
      BUMP="$A";;
    --tag)
      I=$((I+1)); TAG="${ARGS[$I]:-}";;
    --tag=*)
      TAG="${A#*=}";;
    --dry|--dry-run)
      DRY_RUN=1;;
    *)
      # 显式版本号
      if [[ "$A" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
        BUMP="$A"
      else
        echo "未知参数: $A" >&2
        usage; exit 2
      fi
      ;;
  esac
  I=$((I+1))
done

# 基础信息
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VER=$(node -p "require('./package.json').version")
SCOPED_REG=$(npm config get @yeepay:registry || true)

echo "包名: $PKG_NAME"
echo "当前版本: $PKG_VER"

# 校验登录
if ! npm whoami >/dev/null 2>&1; then
  echo "未登录 npm，请先执行: npm login" >&2
  exit 1
fi

# 私有作用域提示
if [[ "$PKG_NAME" != @yeepay/* ]]; then
  echo "警告: 包名不在 @yeepay 作用域下，当前: $PKG_NAME" >&2
fi

if [[ -z "$SCOPED_REG" || "$SCOPED_REG" == "undefined" ]]; then
  echo "提示: 未检测到 @yeepay 作用域 registry 配置，若使用私有源请在 .npmrc 中设置 @yeepay:registry 与 _authToken" >&2
fi

# 版本变更（可选）
if [[ -n "$BUMP" ]]; then
  echo "+ 设置版本: $BUMP (no git tag)"
  npm version "$BUMP" --no-git-tag-version
  PKG_VER=$(node -p "require('./package.json').version")
  echo "新版本: $PKG_VER"
fi

# 试跑/发布
CMD=(npm publish)
if [[ -n "$TAG" ]]; then
  CMD+=(--tag "$TAG")
fi
if (( DRY_RUN )); then
  CMD+=(--dry-run)
fi

echo "+ ${CMD[*]}"
"${CMD[@]}"

echo "✅ 发布完成: $PKG_NAME@$PKG_VER"
