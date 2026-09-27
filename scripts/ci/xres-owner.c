/*
 * #1177 — xres-owner: bounded XRes exact-owned-window ownership probe.
 *
 * PROTOTYPE, ISOLATED LINUX CI ONLY. This file is not wired into any caller. It is
 * compiled and exercised ONLY by .github/workflows/xres-owned-window-prototype.yml,
 * under that workflow's own private Xvfb. `ci.yml` is UNCHANGED in this lane and does
 * not invoke this binary; wiring it in is a separate, later, reviewed change.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *   It answers exactly one question about one XID on one X server: *is this XID a live
 *   window whose owning client is the process the caller names?*  A green run here is
 *   NOT browser acceptance, NOT WebAuthn/TLS execution, NOT installed-product
 *   acceptance, and says NOTHING about Windows or about any real browser.
 *
 * THE CORRECTION THIS FILE IMPLEMENTS (CONTRACT-r2 §A.1, withdrawing v1 §5/§9.4)
 *   v1 claimed a destroyed or never-allocated XID makes XResQueryClientIds raise a
 *   `Value` error. THAT CLAIM IS WITHDRAWN and this probe does not rely on it. Per
 *   resproto.txt:78-84,116-118, an XID is MASKED by resource_mask to find the owning
 *   *client*; the resource low bits are not used. So a bogus XID inside a live client's
 *   range is a *valid client XID* and is expected to answer with that client's pid, with
 *   no error. XRes query success therefore proves only "some live client owns this XID
 *   range". It proves NOTHING about W being a window, or existing, or still being the
 *   window the supervisor saw.
 *
 *   Existence is proved by XGetWindowAttributes (step 2 / step 6), which is defined to
 *   fail BadWindow on a non-window. The XRes call NEVER refuses on absence here.
 *   `--mode bogus` exists to MEASURE this rather than to trust the reading above: it
 *   reports the raw XRes outcome for a deliberately non-existent XID while the contract
 *   verdict it prints is still `w-absent`.
 *
 * ATOMICITY (CONTRACT-r2 §A.3) — grab premise, corroboration status
 *   Steps 1-6 run inside one XGrabServer bracket on ONE connection, because without it W
 *   can be destroyed between the existence check and the XRes query and — per §A.1 — the
 *   XRes query would still answer with the owning pid, so the pair "(W existed) and
 *   (client P owns that range)" would name two different instants.
 *
 *   CORROBORATED in this lane from the official libX11 man page source
 *   (gitlab.freedesktop.org/xorg/lib/libx11 man/XGrabServer.man, HTTP 200):
 *     "The XGrabServer function disables processing of requests and close downs on all
 *      other connections than the one this request arrived on."
 *     "The XUngrabServer function restarts processing of requests and close downs on
 *      other connections."
 *   That is the §A.3 premise, including the "close downs are deferred, so W cannot
 *   disappear mid-bracket" bullet. r2 §A.3 recorded it as UNCITED; it is now cited.
 *   Documentation is still not a measurement of THIS server build, so oracle O-G is
 *   retained and still BLOCKS on failure.
 *
 *   STILL UNCORROBORATED, stated and not invented: that the server releases a grab when
 *   the grabbing client's connection closes. The man page above does not say it. This
 *   probe therefore does not lean on it for correctness — it ungrabs explicitly on every
 *   path it can reach, and the bounded-alarm path below is the one place where only
 *   connection close remains. See REPORT.md "residual premises".
 *
 * PUBLIC API ONLY, version-exact (CONTRACT-r2 §C, from XRes.h at tag libXres-1.2.1)
 *   No hand-written X11 protocol, no private libXres internals, no invented spellings.
 *   XResGetClientIdType is NOT called: it assert()s on an ambiguous mask [XRes.c:320];
 *   spec.mask is read directly. `length` is a BYTE count in the shipped implementation
 *   [XRes.c:243-245] despite the draft's "units of CARD32" prose, and libXres mallocs it
 *   unbounded [XRes.c:244], so any length outside [4,64] is `owner-malformed` BEFORE
 *   value is dereferenced.
 *
 * DISCIPLINE
 *   Creates no resources in any probe mode (so it owns no XID confusable with W).
 *   Interns atoms with only_if_exists=True so it does not even add an atom.
 *   Signals nothing. Kills nothing. Scans no process list. Destroys no window.
 *   Installs a non-fatal X error handler and a non-returning IO error handler, because
 *   Xlib's defaults exit(1) and would produce no record at all.
 *   Prints EXACTLY ONE fixed-shape record line on stdout on every path, then exits.
 *
 * EXIT STATUS — and the v1 §3/§9.5 tension this resolves (see REPORT.md, REVIEW-REQUIRED)
 *   0  verdict=owned
 *   2  a determinate refusal verdict was printed (every w-*, owner-*, grab-unavailable,
 *      xres-unavailable, xres-too-old). Non-zero, which is what v1 oracle 5 requires of
 *      a capability refusal, while the verdict itself stays legible.
 *   1  no usable record: usage error, or a failure before a verdict could be determined.
 *   A caller maps rc 0/2 to the PARSED verdict and anything else to `owner-unreadable`.
 *   v1 §3's "non-zero exit -> owner-unreadable" is read as covering exactly the case
 *   where no record parsed, since the same clause also lists "unparsable output".
 *
 * MODES (a fixed, closed set — deliberately not a framework)
 *   --mode wm      resolve W from the root's _NET_SUPPORTING_WM_CHECK and run the full
 *                  r2 bracket, steps 1-6. THE ACTUAL MEASUREMENT.
 *   --mode xid     existence + ownership only (steps 2,5,6) on --window. For helper
 *                  windows, which are not EWMH supporting windows. Steps 1/3/4 are
 *                  skipped, and `mode=xid` in the record says so, so an oracle control
 *                  can never be mistaken for a full measurement.
 *   --mode bogus   construct a deliberately NON-EXISTENT XID (inside a live client's
 *                  range via --range-of, or outside every range via --outside) and
 *                  record the RAW XRes outcome for it. Oracles O-1 and O-4.
 *   --mode helper  NOT a probe: create one window, print it, and obey line commands on
 *                  stdin. This is the only mode that creates a resource. It exists here
 *                  because this lane is authorized to add exactly three files, and the
 *                  oracles need an X client with a pid the harness itself knows.
 *
 * INSTRUMENTATION (oracle O-G only) — always disclosed in the record
 *   --grab-delay-ms N  artificial delay inside the grab, between step 2 and step 5.
 *   --no-grab          run the same sequence with NO grab: the negative control.
 *   Either one sets instrumented=yes. A caller asserting a real measurement REQUIRES
 *   mode=wm grab=held instrumented=no.
 *
 * Link: cc -O2 -Wall -Wextra -o xres-owner xres-owner.c -lXRes -lX11
 */

#include <sys/types.h>

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/XRes.h>

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define EXIT_OWNED     0
#define EXIT_REFUSED   2
#define EXIT_NORECORD  1

/* Internal bound on the whole grab bracket. Acquisition may block: another client may
 * already hold a grab, and then our first round-trip inside the bracket does not return.
 * Expiry is a REFUSAL (`grab-unavailable`), never absence. The caller's own subprocess
 * bound is separate and larger, so normally this fires first and keeps the verdict
 * legible instead of collapsing to `owner-unreadable`. */
#define GRAB_BOUND_SECONDS 5

/* r2 §C: libXres mallocs `length` unbounded; refuse anything outside this before any
 * dereference of `value`. One CARD32 pid is 4 bytes; 64 is slack, not a parser. */
#define LENGTH_MIN 4
#define LENGTH_MAX 64

/* Bounded candidate searches in --mode bogus. Neither walk is allowed to spin. */
#define BOGUS_TRIES  4096
#define OUTSIDE_TRIES 512

#define RECORD_MAX 512

/* ------------------------------------------------------------------ record state --- */

/* Every field of the one output line. Fixed order, fixed spelling, every field always
 * present, "-" when it does not apply. A caller parses this with one strict pattern;
 * there is no second output shape anywhere in this file. */
static const char *f_mode        = "-";
static const char *f_grab        = "-";   /* held | absent | unavailable */
static const char *f_instrumented= "no";
static long        f_delay_ms    = 0;
static XID         f_window      = 0;     /* W resolved from root (mode wm only) */
static int         f_window_set  = 0;
static XID         f_probed      = 0;     /* the XID actually handed to steps 2/5/6 */
static int         f_probed_set  = 0;
static const char *f_existence   = "-";   /* step 2: ok | badwindow */
static const char *f_step6       = "-";   /* step 6: ok | badwindow */
static const char *f_xres_status = "-";   /* success | failed */
static long        f_num_ids     = -1;
static long        f_length      = -1;
static long        f_pid         = -1;
static long        f_owner_pid   = -1;
static int         f_major       = -1;
static int         f_minor       = -1;

static Display          *g_dpy      = NULL;
static XResClientIdValue *g_ids     = NULL;
static long               g_num_ids = 0;
static int                g_grabbed = 0;

/* X error bookkeeping. Xlib is asynchronous, so each step below clears these, issues its
 * request, and syncs; that way an error is attributed to the step that caused it instead
 * of to whichever step happened to round-trip next. */
static int           g_errors       = 0;
static unsigned char g_error_code   = 0;
static unsigned char g_error_request= 0;

/* Pre-rendered record for the SIGALRM path. snprintf is not async-signal-safe, so the
 * handler may only write() a buffer somebody else already filled in. */
static char  g_alarm_record[RECORD_MAX];
static int   g_alarm_len = 0;

static int render(char *buf, size_t cap, const char *verdict)
{
    char window[24], probed[24], nids[24], len[24], pid[24], owner[24];
    char version[24], xerr[24];

    if (f_window_set) snprintf(window, sizeof window, "0x%lx", (unsigned long) f_window);
    else              snprintf(window, sizeof window, "-");
    if (f_probed_set) snprintf(probed, sizeof probed, "0x%lx", (unsigned long) f_probed);
    else              snprintf(probed, sizeof probed, "-");
    if (f_num_ids >= 0) snprintf(nids, sizeof nids, "%ld", f_num_ids);
    else                snprintf(nids, sizeof nids, "-");
    if (f_length >= 0) snprintf(len, sizeof len, "%ld", f_length);
    else               snprintf(len, sizeof len, "-");
    if (f_pid > 0) snprintf(pid, sizeof pid, "%ld", f_pid);
    else           snprintf(pid, sizeof pid, "-");
    if (f_owner_pid > 0) snprintf(owner, sizeof owner, "%ld", f_owner_pid);
    else                 snprintf(owner, sizeof owner, "-");
    if (f_major >= 0) snprintf(version, sizeof version, "%d.%d", f_major, f_minor);
    else              snprintf(version, sizeof version, "-");
    if (g_errors) snprintf(xerr, sizeof xerr, "%u/%u",
                           (unsigned) g_error_code, (unsigned) g_error_request);
    else          snprintf(xerr, sizeof xerr, "-");

    return snprintf(buf, cap,
                    "xres-owner (verdict=%s mode=%s grab=%s instrumented=%s delay-ms=%ld"
                    " window=%s probed-xid=%s existence=%s step6=%s xres-status=%s"
                    " num-ids=%s length=%s pid=%s owner-pid=%s server-version=%s"
                    " x-error=%s)\n",
                    verdict, f_mode, f_grab, f_instrumented, f_delay_ms,
                    window, probed, f_existence, f_step6, f_xres_status,
                    nids, len, pid, owner, version, xerr);
}

/* Refresh the handler's copy. Called before the grab is taken and again after each step
 * that changes a field the alarm record would carry. */
static void arm_alarm_record(void)
{
    int n = render(g_alarm_record, sizeof g_alarm_record, "grab-unavailable");
    g_alarm_len = (n > 0 && (size_t) n < sizeof g_alarm_record)
                  ? n : (int) strlen(g_alarm_record);
}

static void on_alarm(int signo)
{
    (void) signo;
    /* async-signal-safe only: one write of a buffer rendered earlier, then _exit. The
     * grab is left to the connection close, which is the premise this file declares as
     * UNCORROBORATED above rather than asserting. */
    if (g_alarm_len > 0) {
        ssize_t ignored = write(STDOUT_FILENO, g_alarm_record, (size_t) g_alarm_len);
        (void) ignored;
    }
    _exit(EXIT_REFUSED);
}

/* The one exit. Releases the grab, frees the XRes reply and closes the display on every
 * path (v1 §6), emits exactly one record, and never returns. */
static void finish(const char *verdict, int status)
{
    char buf[RECORD_MAX];
    int n;

    alarm(0);
    if (g_dpy != NULL) {
        if (g_grabbed) {
            XUngrabServer(g_dpy);
            g_grabbed = 0;
            XSync(g_dpy, False);
        }
        if (g_ids != NULL) {
            XResClientIdsDestroy(g_num_ids, g_ids);
            g_ids = NULL;
        }
        XCloseDisplay(g_dpy);
        g_dpy = NULL;
    }
    n = render(buf, sizeof buf, verdict);
    if (n > 0) {
        if (fwrite(buf, 1, (size_t) n, stdout) != (size_t) n) status = EXIT_NORECORD;
        if (fflush(stdout) != 0) status = EXIT_NORECORD;
    } else {
        status = EXIT_NORECORD;
    }
    exit(status);
}

static void refuse(const char *verdict) { finish(verdict, EXIT_REFUSED); }

static int x_error(Display *dpy, XErrorEvent *event)
{
    (void) dpy;
    g_errors++;
    g_error_code = event->error_code;
    g_error_request = event->request_code;
    return 0;   /* non-fatal: the default handler exits and would print no record */
}

/* Xlib requires an IO error handler not to return. A lost connection is not absence. */
static int x_io_error(Display *dpy)
{
    (void) dpy;
    g_dpy = NULL;      /* the connection is gone; do not touch it in finish() */
    g_grabbed = 0;
    g_ids = NULL;
    finish("owner-refused", EXIT_REFUSED);
    _exit(EXIT_REFUSED);
}

static void clear_errors(void)
{
    g_errors = 0;
    g_error_code = 0;
    g_error_request = 0;
}

/* Flush pending errors so they are attributed to the step just issued. */
static int step_failed(void)
{
    XSync(g_dpy, False);
    return g_errors != 0;
}

static int is_bad_window(void)
{
    return g_errors != 0 && g_error_code == BadWindow;
}

/* ------------------------------------------------------------------- probe steps --- */

/* XGetWindowAttributes: defined to fail BadWindow on an XID that is not a currently
 * existing window. THIS, and not the XRes call, is what refuses a destroyed or
 * never-allocated W (r2 §A.2). Returns 1 when W exists. */
static int window_exists(XID w)
{
    XWindowAttributes attrs;
    Status ok;

    clear_errors();
    ok = XGetWindowAttributes(g_dpy, (Window) w, &attrs);
    if (step_failed() || ok == 0) return 0;
    return 1;
}

/* One 32-bit window-typed property. Returns 1 and sets *out on a single clean value,
 * 0 when the property is absent or not in that shape, -1 on an X error. */
static int read_window_property(XID target, Atom property, XID *out)
{
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *data = NULL;
    int status;

    clear_errors();
    status = XGetWindowProperty(g_dpy, (Window) target, property, 0, 1, False,
                                XA_WINDOW, &actual_type, &actual_format,
                                &nitems, &bytes_after, &data);
    if (step_failed() || status != Success) {
        if (data != NULL) XFree(data);
        return -1;
    }
    if (actual_type != XA_WINDOW || actual_format != 32 || nitems != 1 || data == NULL) {
        if (data != NULL) XFree(data);
        return 0;
    }
    *out = (XID) *(unsigned long *) (void *) data;
    XFree(data);
    return 1;
}

/* _NET_WM_NAME must be READABLE and must contain "Openbox". A name that cannot be read
 * is never accepted; the name is one REQUIRED link and substitutes for nothing. */
static int name_contains_openbox(XID w, Atom net_wm_name)
{
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *data = NULL;
    int status, found = 0;

    clear_errors();
    status = XGetWindowProperty(g_dpy, (Window) w, net_wm_name, 0, 64, False,
                                AnyPropertyType, &actual_type, &actual_format,
                                &nitems, &bytes_after, &data);
    if (step_failed() || status != Success) {
        if (data != NULL) XFree(data);
        return -1;
    }
    if (data != NULL && actual_format == 8 && nitems > 0) {
        char name[257];
        size_t n = nitems < sizeof name - 1 ? (size_t) nitems : sizeof name - 1;
        memcpy(name, data, n);
        name[n] = '\0';
        found = strstr(name, "Openbox") != NULL;
    }
    if (data != NULL) XFree(data);
    return found;
}

static void sleep_ms(long ms)
{
    struct timespec want;
    if (ms <= 0) return;
    want.tv_sec = ms / 1000;
    want.tv_nsec = (ms % 1000) * 1000000L;
    while (nanosleep(&want, &want) == -1 && errno == EINTR) { /* SIGALRM handles itself */ }
}

/* Step 5. Records the RAW outcome in the report fields and returns the contract verdict
 * for the ownership half, or NULL when the ownership half passed all of r2 §A.5's
 * structural conditions. It never refuses on absence — that is steps 2 and 6. */
static const char *query_ownership(XID w)
{
    XResClientIdSpec spec;
    long num_ids = 0;
    XResClientIdValue *ids = NULL;
    Status status;
    pid_t pid;

    spec.client = w;                              /* one non-wildcard spec; never None */
    spec.mask = XRES_CLIENT_ID_PID_MASK;

    clear_errors();
    status = XResQueryClientIds(g_dpy, 1, &spec, &num_ids, &ids);
    XSync(g_dpy, False);
    g_ids = ids;
    g_num_ids = num_ids;
    f_num_ids = num_ids;
    f_xres_status = (status == Success) ? "success" : "failed";

    if (status != Success) return "owner-refused";
    if (num_ids == 0) return "owner-unknown";      /* NOT absence, never downgraded */
    if (num_ids > 1) return "owner-ambiguous";
    if (ids == NULL) return "owner-malformed";
    if (ids[0].spec.client != w) return "owner-ambiguous";
    if (ids[0].spec.mask != (unsigned int) XRES_CLIENT_ID_PID_MASK) return "owner-ambiguous";

    f_length = ids[0].length;
    /* Bound BEFORE any dereference of value: the public field is a signed long, so this
     * also rejects negatives, and libXres does not sanity-bound its malloc. */
    if (ids[0].length < LENGTH_MIN || ids[0].length > LENGTH_MAX) return "owner-malformed";
    if (ids[0].value == NULL) return "owner-malformed";

    pid = XResGetClientPid(&ids[0]);               /* -1 when there is no pid */
    f_pid = (long) pid;
    if (pid <= 0 || pid == (pid_t) -1) return "owner-malformed";
    return NULL;
}

/* ------------------------------------------------------------------ bogus XID mode --- */

/* O-1 / O-4. Builds an XID that is deliberately NOT a live window, either inside a live
 * client's range (settles §A.1 by measurement) or outside every live range. The exact
 * client/resource bit split is READ from XResQueryClients — no bit width is guessed.
 * Returns 1 and sets *out, or 0 when no candidate could be built inside the bounds. */
static int build_bogus_xid(XID inside_of, int outside, XID *out)
{
    int num_clients = 0, i;
    XResClient *clients = NULL;
    XID base = 0, mask = 0;
    int have_range = 0;

    clear_errors();
    /* NOTE the return conventions of libXres are NOT uniform and are taken from the
     * source rather than assumed: XResQueryClients returns 1 on success and 0 otherwise
     * [XRes.c:89-140, including 0 when the reply carried no clients], while
     * XResQueryClientIds returns `Success` (== 0) on success [XRes.c:290-300]. */
    if (XResQueryClients(g_dpy, &num_clients, &clients) != 1) {
        if (clients != NULL) XFree(clients);
        return 0;
    }
    XSync(g_dpy, False);
    if (clients == NULL || num_clients <= 0) {
        if (clients != NULL) XFree(clients);
        return 0;
    }

    if (!outside) {
        for (i = 0; i < num_clients; i++) {
            if ((inside_of & ~clients[i].resource_mask) == clients[i].resource_base) {
                base = clients[i].resource_base;
                mask = clients[i].resource_mask;
                have_range = 1;
                break;
            }
        }
        if (!have_range) { XFree(clients); return 0; }
        /* Walk the top of that client's own range downwards for an unallocated low part.
         * Confirmed unallocated by BadWindow, which is the same request the contract
         * uses for existence — not by assuming high ids are free. */
        for (XID k = mask; k > 0 && (mask - k) < BOGUS_TRIES; k--) {
            XID candidate = base | k;
            if (candidate == inside_of) continue;
            if (!window_exists(candidate) && is_bad_window()) {
                *out = candidate;
                XFree(clients);
                return 1;
            }
        }
        XFree(clients);
        return 0;
    }

    /* Outside every live range: step the client field, which is whatever bits are left
     * over from the resource_mask this server reported. */
    mask = clients[0].resource_mask;
    for (i = 1; i < num_clients; i++) {
        if (clients[i].resource_mask != mask) { XFree(clients); return 0; }
    }
    for (int slot = OUTSIDE_TRIES; slot >= 1; slot--) {
        XID candidate_base = (XID) slot * (mask + 1);
        int taken = 0;
        for (i = 0; i < num_clients; i++) {
            if (clients[i].resource_base == candidate_base) { taken = 1; break; }
        }
        if (taken) continue;
        XID candidate = candidate_base | 1;
        if (!window_exists(candidate) && is_bad_window()) {
            *out = candidate;
            XFree(clients);
            return 1;
        }
    }
    XFree(clients);
    return 0;
}

/* ---------------------------------------------------------------------- helper mode --- */

/* NOT a probe. One window, a pid the caller already owns through its own handle, and a
 * line protocol so the caller drives the races deterministically instead of guessing at
 * sleeps. Commands: destroy, grab, ungrab, exit. */
static int run_helper(void)
{
    Window root, w;
    char line[64];

    root = DefaultRootWindow(g_dpy);
    clear_errors();
    w = XCreateSimpleWindow(g_dpy, root, 0, 0, 1, 1, 0, 0, 0);
    XSync(g_dpy, False);
    if (g_errors != 0 || w == None) {
        printf("xres-owner-helper (state=failed window=- pid=%ld)\n", (long) getpid());
        fflush(stdout);
        return EXIT_NORECORD;
    }
    /* Deliberately NOT mapped: an unmapped window still exists for XGetWindowAttributes
     * and for XRes, and mapping it would invite the window manager to manage it. */
    printf("xres-owner-helper (state=ready window=0x%lx pid=%ld)\n",
           (unsigned long) w, (long) getpid());
    fflush(stdout);

    while (fgets(line, sizeof line, stdin) != NULL) {
        char *nl = strchr(line, '\n');
        if (nl != NULL) *nl = '\0';
        if (strcmp(line, "destroy") == 0) {
            clear_errors();
            XDestroyWindow(g_dpy, w);
            XSync(g_dpy, False);
            printf("xres-owner-helper (command=destroy result=%s)\n",
                   g_errors ? "failed" : "ok");
        } else if (strcmp(line, "grab") == 0) {
            XGrabServer(g_dpy);
            XSync(g_dpy, False);
            g_grabbed = 1;
            printf("xres-owner-helper (command=grab result=ok)\n");
        } else if (strcmp(line, "ungrab") == 0) {
            XUngrabServer(g_dpy);
            XSync(g_dpy, False);
            g_grabbed = 0;
            printf("xres-owner-helper (command=ungrab result=ok)\n");
        } else if (strcmp(line, "exit") == 0) {
            printf("xres-owner-helper (command=exit result=ok)\n");
            fflush(stdout);
            break;
        } else {
            printf("xres-owner-helper (command=unknown result=refused)\n");
        }
        fflush(stdout);
    }
    if (g_grabbed) { XUngrabServer(g_dpy); XSync(g_dpy, False); g_grabbed = 0; }
    XCloseDisplay(g_dpy);
    g_dpy = NULL;
    return EXIT_OWNED;
}

/* --------------------------------------------------------------------------- main --- */

static void usage(void)
{
    fprintf(stderr,
            "usage: xres-owner --mode wm     --owner-pid N [--grab-delay-ms N] [--no-grab]\n"
            "       xres-owner --mode xid    --window 0xID --owner-pid N"
            " [--grab-delay-ms N] [--no-grab]\n"
            "       xres-owner --mode bogus  (--range-of 0xID | --outside)\n"
            "       xres-owner --mode helper\n");
}

static int parse_xid(const char *text, XID *out)
{
    char *end = NULL;
    unsigned long value;
    errno = 0;
    value = strtoul(text, &end, 0);
    if (errno != 0 || end == NULL || *end != '\0') return 0;
    *out = (XID) value;
    return 1;
}

int main(int argc, char **argv)
{
    const char *mode = NULL;
    XID want_window = 0, range_of = 0, probed = 0;
    int have_window = 0, have_range_of = 0, outside = 0, no_grab = 0;
    long owner_pid = -1, delay_ms = 0;
    int event_base = 0, error_base = 0;
    int major = 0, minor = 0;
    Window root;
    Atom supporting, net_wm_name;
    const char *verdict;
    struct sigaction alarm_action;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        const char *value = (i + 1 < argc) ? argv[i + 1] : NULL;
        if (strcmp(arg, "--mode") == 0 && value != NULL) { mode = value; i++; }
        else if (strcmp(arg, "--window") == 0 && value != NULL) {
            if (!parse_xid(value, &want_window)) { usage(); return EXIT_NORECORD; }
            have_window = 1; i++;
        } else if (strcmp(arg, "--range-of") == 0 && value != NULL) {
            if (!parse_xid(value, &range_of)) { usage(); return EXIT_NORECORD; }
            have_range_of = 1; i++;
        } else if (strcmp(arg, "--owner-pid") == 0 && value != NULL) {
            char *end = NULL;
            errno = 0;
            owner_pid = strtol(value, &end, 10);
            if (errno != 0 || end == NULL || *end != '\0' || owner_pid <= 0) {
                usage(); return EXIT_NORECORD;
            }
            i++;
        } else if (strcmp(arg, "--grab-delay-ms") == 0 && value != NULL) {
            char *end = NULL;
            errno = 0;
            delay_ms = strtol(value, &end, 10);
            if (errno != 0 || end == NULL || *end != '\0' || delay_ms < 0) {
                usage(); return EXIT_NORECORD;
            }
            i++;
        } else if (strcmp(arg, "--outside") == 0) { outside = 1; }
        else if (strcmp(arg, "--no-grab") == 0) { no_grab = 1; }
        else { usage(); return EXIT_NORECORD; }
    }

    if (mode == NULL) { usage(); return EXIT_NORECORD; }
    if (strcmp(mode, "wm") != 0 && strcmp(mode, "xid") != 0 &&
        strcmp(mode, "bogus") != 0 && strcmp(mode, "helper") != 0) {
        usage(); return EXIT_NORECORD;
    }
    if (strcmp(mode, "xid") == 0 && !have_window) { usage(); return EXIT_NORECORD; }
    if ((strcmp(mode, "wm") == 0 || strcmp(mode, "xid") == 0) && owner_pid <= 0) {
        usage(); return EXIT_NORECORD;
    }
    if (strcmp(mode, "bogus") == 0 && (have_range_of == outside)) {
        usage(); return EXIT_NORECORD;   /* exactly one of --range-of / --outside */
    }

    f_mode = mode;
    f_owner_pid = owner_pid;
    f_delay_ms = delay_ms;
    if (delay_ms > 0 || no_grab) f_instrumented = "yes";

    XSetErrorHandler(x_error);
    XSetIOErrorHandler(x_io_error);

    g_dpy = XOpenDisplay(NULL);
    if (g_dpy == NULL) {
        /* No connection, so no verdict about any window is available. This is the
         * caller's `owner-unreadable`, and it is reported as no-record on purpose. */
        fprintf(stderr, "xres-owner: could not open the display\n");
        return EXIT_NORECORD;
    }

    if (strcmp(mode, "helper") == 0) return run_helper();

    /* The bound is armed HERE, before the first round trip, not just around the bracket.
     * Every request this process makes after connecting can be held by another client's
     * server grab — the capability gate and the atom interning below are round trips too —
     * so bounding only the bracket would leave a legible-record gap that the caller could
     * only see as an opaque subprocess timeout. Expiry is `grab-unavailable`: contention
     * with another client's grab is the only thing that holds our requests this way, and
     * the record's empty `probed-xid`/`existence` fields show how far it got. Expiry is
     * ALWAYS a refusal and never absence. */
    memset(&alarm_action, 0, sizeof alarm_action);
    alarm_action.sa_handler = on_alarm;
    sigemptyset(&alarm_action.sa_mask);
    if (sigaction(SIGALRM, &alarm_action, NULL) != 0) {
        finish("owner-refused", EXIT_REFUSED);
    }
    arm_alarm_record();
    alarm((unsigned) (GRAB_BOUND_SECONDS + (delay_ms + 999) / 1000));

    /* Capability gate, fail-closed, all before any verdict about a window (v1 §2). */
    if (!XResQueryExtension(g_dpy, &event_base, &error_base)) refuse("xres-unavailable");
    clear_errors();
    /* XResQueryVersion returns 1 on success, 0 on failure [XRes.c:61-87]. */
    if (XResQueryVersion(g_dpy, &major, &minor) != 1) refuse("xres-unavailable");
    XSync(g_dpy, False);
    f_major = major;
    f_minor = minor;
    if (major < 1 || (major == 1 && minor < 2)) refuse("xres-too-old");
    /* Whether this server implements LocalClientPid at all is proved by NO source and is
     * NOT assumed: its absence surfaces as owner-unknown below and BLOCKS. */

    root = DefaultRootWindow(g_dpy);
    /* only_if_exists=True: this probe does not even add an atom. A missing supporting
     * atom means nothing ever registered, which is w-unregistered, not an error. */
    supporting = XInternAtom(g_dpy, "_NET_SUPPORTING_WM_CHECK", True);
    net_wm_name = XInternAtom(g_dpy, "_NET_WM_NAME", True);
    XSync(g_dpy, False);

    if (strcmp(mode, "bogus") == 0) {
        /* O-1 / O-4. No grab: nothing here is a claim about a live window, and the point
         * is to record what the XRes call does for an XID that is NOT one. */
        f_grab = "absent";
        f_instrumented = "yes";     /* an artificial control, never a real measurement */
        if (!build_bogus_xid(range_of, outside, &probed)) {
            fprintf(stderr, "xres-owner: no bogus XID could be constructed within"
                            " the bounded search\n");
            finish("owner-unreadable", EXIT_NORECORD);
        }
        f_probed = probed;
        f_probed_set = 1;
        /* Existence is checked FIRST and is expected to fail; build_bogus_xid already
         * confirmed BadWindow, and this records it in the report fields. */
        f_existence = window_exists(probed) ? "ok" : "badwindow";
        /* Then the raw XRes outcome for that same non-existent XID is RECORDED. The
         * prediction from §A.1 is deliberately NOT asserted here: whatever the server
         * answers is what the record carries, and the caller compares it with the pid it
         * already knows. */
        (void) query_ownership(probed);
        if (strcmp(f_existence, "badwindow") == 0) {
            /* This, not the XRes return value, is what refuses. O-4's real assertion is
             * that neither bogus XID can ever come out `owned`. */
            finish("w-absent", EXIT_REFUSED);
        }
        finish("owner-ambiguous", EXIT_REFUSED);   /* the XID we built turned out live */
    }

    /* ---- the r2 bracket ---- */
    /* Re-arm: the bound above already covered the capability gate, and the bracket gets
     * the full budget of its own rather than whatever was left over from it. */
    arm_alarm_record();
    alarm((unsigned) (GRAB_BOUND_SECONDS + (delay_ms + 999) / 1000));

    if (no_grab) {
        f_grab = "absent";          /* O-G negative control ONLY */
    } else {
        XGrabServer(g_dpy);
        g_grabbed = 1;
        f_grab = "held";
    }

    if (strcmp(mode, "wm") == 0) {
        XID w = 0, back = 0;
        int got;

        /* 1. root -> W, inside the grab, so the root pointer and W's existence below are
         *    consistent with each other. */
        if (supporting == None) finish("w-unregistered", EXIT_REFUSED);
        got = read_window_property(root, supporting, &w);
        if (got < 0) finish("owner-refused", EXIT_REFUSED);
        if (got == 0) finish("w-unregistered", EXIT_REFUSED);
        f_window = w;
        f_window_set = 1;
        f_probed = w;
        f_probed_set = 1;
        arm_alarm_record();

        /* 2. EXISTENCE. */
        if (!window_exists(w)) {
            f_existence = "badwindow";
            finish("w-absent", EXIT_REFUSED);
        }
        f_existence = "ok";

        /* 3. W points back at itself — the EWMH staleness test. */
        got = read_window_property(w, supporting, &back);
        if (got < 0) finish("owner-refused", EXIT_REFUSED);
        if (got == 0 || back != w) finish("w-not-self", EXIT_REFUSED);

        /* 4. W is named Openbox. A name that could not be read is not a pass. */
        if (net_wm_name == None) finish("w-foreign-wm", EXIT_REFUSED);
        got = name_contains_openbox(w, net_wm_name);
        if (got < 0) finish("owner-refused", EXIT_REFUSED);
        if (got == 0) finish("w-foreign-wm", EXIT_REFUSED);

        sleep_ms(delay_ms);                       /* O-G instrumentation only */

        /* 5. OWNERSHIP. */
        verdict = query_ownership(w);
        if (verdict != NULL) finish(verdict, EXIT_REFUSED);

        /* 6. The cheap re-check that catches a grab which did not hold. */
        if (!window_exists(w)) {
            f_step6 = "badwindow";
            finish("w-absent", EXIT_REFUSED);
        }
        f_step6 = "ok";
        probed = w;
    } else {
        /* mode xid: steps 2, 5, 6 only. Steps 1/3/4 do not apply to a window that is not
         * an EWMH supporting window, and `mode=xid` in the record keeps this control
         * distinguishable from the full measurement above. */
        probed = want_window;
        f_probed = probed;
        f_probed_set = 1;
        arm_alarm_record();

        if (!window_exists(probed)) {
            f_existence = "badwindow";
            finish("w-absent", EXIT_REFUSED);
        }
        f_existence = "ok";

        sleep_ms(delay_ms);

        verdict = query_ownership(probed);
        if (verdict != NULL) finish(verdict, EXIT_REFUSED);

        if (!window_exists(probed)) {
            f_step6 = "badwindow";
            finish("w-absent", EXIT_REFUSED);
        }
        f_step6 = "ok";
    }

    /* `grab-unavailable` is produced by the SIGALRM path above and only there: XGrabServer
     * has no reply and cannot itself report failure, so contention shows up as a
     * round-trip inside the bracket that does not return, which is exactly what the bound
     * catches. There is deliberately no second, guessed source for that verdict. */

    /* The numeric comparison. The caller's Popen handle is the authenticated identity;
     * this number arrived through --owner-pid and the caller re-compares the pid printed
     * below against that same handle, so this exit status is never the only check. */
    if (f_pid != owner_pid) finish("owner-foreign", EXIT_REFUSED);

    finish("owned", EXIT_OWNED);
    return EXIT_NORECORD;   /* not reached; finish() exits */
}
