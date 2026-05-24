#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
PYTHON_BIN="${VENV_DIR}/bin/python"
PIP_BIN="${VENV_DIR}/bin/pip"
REQ_FILE="${SCRIPT_DIR}/requirements.txt"
PIP_EXTRA_INDEX_URL_DEFAULT="${HARNESS_PIP_EXTRA_INDEX_URL:-https://pypi.org/simple}"

pick_python() {
  for candidate in python3.11 python3.10 python3.12 python3; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      "${candidate}" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
      if [[ $? -eq 0 ]]; then
        command -v "${candidate}"
        return 0
      fi
    fi
  done

  echo "[harness] no suitable Python interpreter found. Please provide Python 3.10+." >&2
  exit 1
}

BOOTSTRAP_PYTHON="$(pick_python)"

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "[harness] creating virtualenv at ${VENV_DIR} with ${BOOTSTRAP_PYTHON}"
  "${BOOTSTRAP_PYTHON}" -m venv "${VENV_DIR}"
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "[harness] python not found in ${VENV_DIR}" >&2
  exit 1
fi

if ! "${PYTHON_BIN}" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
then
  echo "[harness] existing virtualenv uses Python < 3.10, recreating it"
  rm -rf "${VENV_DIR}"
  "${BOOTSTRAP_PYTHON}" -m venv "${VENV_DIR}"
fi

if [[ ! -f "${VENV_DIR}/.deps_installed" || "${REQ_FILE}" -nt "${VENV_DIR}/.deps_installed" ]]; then
  echo "[harness] installing dependencies"
  "${PIP_BIN}" install --upgrade pip >/dev/null
  "${PIP_BIN}" install --extra-index-url "${PIP_EXTRA_INDEX_URL_DEFAULT}" -r "${REQ_FILE}"
  touch "${VENV_DIR}/.deps_installed"
fi

cd "${REPO_ROOT}"
exec "${PYTHON_BIN}" -u -m lab.harness.run_benchmark "$@"
