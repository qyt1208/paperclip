/*
 * Paperclip Windows git/gh launcher shim (console subsystem).
 *
 * Build (x64):
 *   x86_64-w64-mingw32-gcc -Os -s -mconsole -o github-launcher-shim-x64.exe github-launcher-shim.c
 *
 * Staged as git.exe or gh.exe beside node.path and git.cjs/gh.cjs. CreateProcess
 * can start this image. cmd.exe and PowerShell select it through PATHEXT.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static void die(const char *msg) {
    HANDLE handle = GetStdHandle(STD_ERROR_HANDLE);
    DWORD written = 0;
    if (handle != NULL && handle != INVALID_HANDLE_VALUE) {
        WriteFile(handle, msg, lstrlenA(msg), &written, NULL);
    }
    ExitProcess(127);
}

static WCHAR *skip_argv0(WCHAR *command) {
    if (*command == L'"') {
        command++;
        while (*command != L'\0') {
            if (*command == L'\\' && command[1] != L'\0') {
                command += 2;
                continue;
            }
            if (*command == L'"') {
                command++;
                break;
            }
            command++;
        }
        return command;
    }
    while (*command != L'\0' && *command != L' ' && *command != L'\t') command++;
    return command;
}

static BOOL ends_with_exe(const WCHAR *path) {
    int length = lstrlenW(path);
    return length >= 4 &&
        path[length - 4] == L'.' &&
        (path[length - 3] == L'e' || path[length - 3] == L'E') &&
        (path[length - 2] == L'x' || path[length - 2] == L'X') &&
        (path[length - 1] == L'e' || path[length - 1] == L'E');
}

static void strip_trailing_newline(char *text, DWORD *length) {
    while (*length > 0 && (text[*length - 1] == '\n' || text[*length - 1] == '\r' || text[*length - 1] == ' ' || text[*length - 1] == '\t')) {
        text[--(*length)] = '\0';
    }
}

static BOOL invalid_node_path(const WCHAR *path) {
    int index;
    if (path[0] == L'\0') return TRUE;
    for (index = 0; path[index] != L'\0'; index++) {
        WCHAR ch = path[index];
        if (ch == L'"' || ch == L'\r' || ch == L'\n' || ch < 0x20) return TRUE;
    }
    if (((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
        path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) return FALSE;
    if (path[0] == L'\\' && path[1] == L'\\') return FALSE;
    return TRUE;
}

static void append(WCHAR *dest, const WCHAR *src, int *used, int cap) {
    int length = lstrlenW(src);
    if (*used + length >= cap) die("Paperclip: Windows Git command line is too long.\n");
    lstrcpyW(dest + *used, src);
    *used += length;
}

int main(void) {
    WCHAR module_path[32768];
    WCHAR node_file_path[32768];
    WCHAR node_path[32768];
    WCHAR script_path[32768];
    WCHAR command[32768];
    WCHAR *raw_command;
    WCHAR *rest;
    WCHAR *file_name;
    char node_utf8[32768];
    DWORD module_length;
    DWORD node_bytes = 0;
    HANDLE node_file;
    STARTUPINFOW startup;
    PROCESS_INFORMATION info;
    DWORD exit_code = 127;
    int directory_length;
    int used = 0;

    SetConsoleCtrlHandler(NULL, TRUE);
    module_length = GetModuleFileNameW(NULL, module_path, 32767);
    if (module_length == 0 || module_length >= 32767 || !ends_with_exe(module_path)) {
        die("Paperclip: Windows Git launcher could not resolve its own path.\n");
    }
    file_name = module_path + module_length;
    while (file_name > module_path && file_name[-1] != L'\\' && file_name[-1] != L'/') file_name--;
    directory_length = (int)(file_name - module_path);
    if (directory_length <= 0 || directory_length >= 32000) die("Paperclip: Windows Git launcher path is too long.\n");

    if (!lstrcpynW(script_path, module_path, directory_length + 1)) die("Paperclip: Windows Git launcher path is too long.\n");
    if (lstrlenW(script_path) + lstrlenW(file_name) >= 32767) die("Paperclip: Windows Git launcher path is too long.\n");
    lstrcatW(script_path, file_name);
    if (!ends_with_exe(script_path)) die("Paperclip: Windows Git launcher could not resolve its own path.\n");
    script_path[lstrlenW(script_path) - 3] = L'c';
    script_path[lstrlenW(script_path) - 2] = L'j';
    script_path[lstrlenW(script_path) - 1] = L's';

    if (!lstrcpynW(node_file_path, module_path, directory_length + 1)) die("Paperclip: Windows Git launcher path is too long.\n");
    if (lstrlenW(node_file_path) + 10 >= 32767) die("Paperclip: Windows Git launcher path is too long.\n");
    lstrcatW(node_file_path, L"node.path");
    node_file = CreateFileW(node_file_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (node_file == INVALID_HANDLE_VALUE) die("Paperclip: Windows Git launcher is missing node.path.\n");
    if (!ReadFile(node_file, node_utf8, sizeof node_utf8 - 1, &node_bytes, NULL)) {
        CloseHandle(node_file);
        die("Paperclip: Windows Git launcher could not read node.path.\n");
    }
    CloseHandle(node_file);
    if (node_bytes == 0 || node_bytes >= sizeof node_utf8 - 1) die("Paperclip: Windows Git launcher node.path is invalid.\n");
    node_utf8[node_bytes] = '\0';
    strip_trailing_newline(node_utf8, &node_bytes);
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, node_utf8, -1, node_path, 32767) <= 0 || invalid_node_path(node_path)) {
        die("Paperclip: Windows Git launcher node.path is invalid.\n");
    }

    raw_command = GetCommandLineW();
    if (raw_command == NULL) die("Paperclip: Windows Git launcher could not read its command line.\n");
    rest = skip_argv0(raw_command);
    append(command, L"\"", &used, 32767);
    append(command, node_path, &used, 32767);
    append(command, L"\" \"", &used, 32767);
    append(command, script_path, &used, 32767);
    append(command, L"\"", &used, 32767);
    append(command, rest, &used, 32767);

    ZeroMemory(&startup, sizeof startup);
    startup.cb = sizeof startup;
    ZeroMemory(&info, sizeof info);
    if (!CreateProcessW(node_path, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &info)) {
        die("Paperclip: Windows Git launcher could not start Node.\n");
    }
    WaitForSingleObject(info.hProcess, INFINITE);
    if (!GetExitCodeProcess(info.hProcess, &exit_code)) exit_code = 127;
    CloseHandle(info.hThread);
    CloseHandle(info.hProcess);
    ExitProcess(exit_code);
    return (int)exit_code;
}
