/* Local-only native executable for lifecycle tests: never opens a browser. */
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *descriptor;
static void stopped(int signal_number) {
    (void)signal_number;
    unlink(descriptor);
    _exit(0);
}
int main(void) {
    const char *root = getenv("CODEXIFY_BROWSER_HOME");
    const char *build = getenv("CODEXIFY_BROWSER_BUILD");
    descriptor = getenv("CODEXIFY_BROWSER_DESCRIPTOR");
    if (!root || !build || !descriptor) return 2;
    char path[4096], temporary[4096];
    signal(SIGTERM, stopped);
    signal(SIGINT, stopped);
    signal(SIGPIPE, SIG_IGN);
    snprintf(path, sizeof(path), "%s/starts", root);
    FILE *file = fopen(path, "a");
    if (!file) return 3;
    fprintf(file, "%ld\n", (long)getpid()); fclose(file);
    snprintf(path, sizeof(path), "%s/delay-start", root);
    if (access(path, F_OK) == 0) sleep(20);
    snprintf(path, sizeof(path), "%s/health-mode", root); unlink(path);
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(0x7f000001u);
#ifdef __APPLE__
    address.sin_len = sizeof(address);
#endif
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0) return 4;
    if (listen(listener, 16) != 0) return 5;
    socklen_t size = sizeof(address);
    if (getsockname(listener, (struct sockaddr *)&address, &size) != 0) return 6;
    snprintf(temporary, sizeof(temporary), "%s.tmp", descriptor);
    int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return 7;
    file = fdopen(fd, "w");
    fprintf(file, "{\"version\":1,\"kind\":\"codexify-browser-companion\",\"pid\":%ld,\"endpoint\":\"http://127.0.0.1:%u/\",\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"build\":\"%s\",\"createdAt\":\"2026-10-18T00:00:00Z\"}", (long)getpid(), ntohs(address.sin_port), build);
    fclose(file);
    if (rename(temporary, descriptor) != 0) return 8;
    for (;;) {
        int connection = accept(listener, NULL, NULL);
        if (connection < 0) continue;
        char request[8192] = {0};
        ssize_t count = read(connection, request, sizeof(request) - 1);
        if (count <= 0) { close(connection); continue; }
        snprintf(path, sizeof(path), "%s/requests", root);
        file = fopen(path, "a");
        if (file) { char *end = strstr(request, "\r\n"); if (end) *end = 0; fprintf(file, "%s\n", request); if (end) *end = '\r'; fclose(file); }
        char mode[64] = "idle";
        snprintf(path, sizeof(path), "%s/health-mode", root);
        file = fopen(path, "r");
        if (file) { if (!fgets(mode, sizeof(mode), file)) strcpy(mode, "idle"); fclose(file); }
        if (strcmp(mode, "frozen") == 0) { signal(SIGTERM, SIG_IGN); for (;;) pause(); }
        int authenticated = strcmp(mode, "authentication_required") != 0 && strcmp(mode, "unavailable") != 0 && strcmp(mode,"session_unavailable") != 0;
        char body[2048];
        int length;
        if (strncmp(request, "GET /v1/liveness ", 17) == 0) {
            length=snprintf(body,sizeof(body),"{\"protocolVersion\":1,\"build\":\"%s\",\"available\":%s}",build,strcmp(mode,"unavailable")==0?"false":"true");
        } else
        length = snprintf(body, sizeof(body), "{\"protocolVersion\":1,\"kind\":\"codexify-browser-companion\",\"build\":\"%s\",\"status\":\"%s\",\"authenticated\":%s,\"accountFingerprint\":%s,\"activeActionId\":%s}", build, strcmp(mode,"session_unavailable")==0?"unavailable":mode, authenticated ? "true" : "false", authenticated ? "\"lifecycle-account\"" : "null", strcmp(mode, "busy") == 0 ? "\"existing-action\"" : "null");
        dprintf(connection, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", length, body);
        close(connection);
    }
}
