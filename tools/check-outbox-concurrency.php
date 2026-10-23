<?php
// Local integration probe: real MySQL locks, simulated audit transport, synthetic rows only.
require '/app/services/configuration/vendor/autoload.php';
$app = require '/app/services/configuration/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Srd\OutboxPublisher;

if (!app()->environment('local') || config('database.default') !== 'mysql' || getenv('SRD_ALLOW_OUTBOX_PROBE') !== '1') {
    throw new RuntimeException('This probe requires the explicitly selected local MySQL environment.');
}

function requireProbe(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

if (($argv[1] ?? '') === 'worker') {
    [$unused, $mode, $directory, $id, $frozen, $index, $success] = $argv;
    $base = realpath(storage_path('framework')) . DIRECTORY_SEPARATOR;
    requireProbe(is_dir($directory) && str_starts_with(realpath($directory), $base.'outbox-probe-'), 'Invalid probe directory.');
    requireProbe(Str::isUuid($id) && in_array($index, ['0', '1'], true), 'Invalid probe input.');
    Carbon::setTestNow($frozen);
    Http::fake(function () use ($directory, $success) {
        file_put_contents($directory.'/requests', "attempt\n", FILE_APPEND | LOCK_EX);
        usleep(800000); // Holds the transaction while the other worker contends for the row.
        return Http::response(['data' => ['accepted' => $success === '1']], $success === '1' ? 200 : 503);
    });
    file_put_contents($directory.'/ready-'.$index, 'ready');
    $deadline = microtime(true) + 20;
    while (!is_file($directory.'/start')) {
        requireProbe(microtime(true) < $deadline, 'Start barrier timeout.');
        usleep(10000);
    }
    $start = microtime(true);
    $outcome = app(OutboxPublisher::class)->publishOne($id);
    file_put_contents($directory.'/result-'.$index, json_encode(['outcome' => $outcome, 'elapsed' => microtime(true)-$start], JSON_THROW_ON_ERROR));
    exit(0);
}

$ids = [];
$directories = [];
$processes = [];
try {
    foreach ([['success', 0, true, 'published'], ['deferred', 0, false, 'retry'], ['exhausted', 3, false, 'exhausted']] as [$name, $attempts, $success, $expected]) {
        $id = (string) Str::uuid();
        $ids[] = $id;
        $directory = storage_path('framework/outbox-probe-'.$id);
        requireProbe(mkdir($directory, 0700), 'Could not create probe directory.');
        $directories[] = $directory;
        // Future timestamp isolates rows from the live scheduler; workers alone advance their clock.
        $frozen = now()->addDays(2)->startOfSecond()->toDateTimeString();
        DB::table('outbox_events')->insert(['id' => $id, 'organization_id' => null, 'actor_id' => null, 'resource_id' => $id,
            'action' => 'outbox.integration_probe', 'result' => 'success', 'correlation_id' => (string) Str::uuid(),
            'occurred_at' => now(), 'attempts' => $attempts, 'next_attempt_at' => $frozen]);
        $processes = [];
        foreach ([0, 1] as $index) {
            $process = proc_open([PHP_BINARY, __FILE__, 'worker', $directory, $id, $frozen, (string) $index, $success ? '1' : '0'],
                [0 => ['file', '/dev/null', 'r'], 1 => ['file', $directory.'/stdout-'.$index, 'w'], 2 => ['file', $directory.'/stderr-'.$index, 'w']], $pipes);
            requireProbe(is_resource($process), 'Could not launch competing publisher.');
            $processes[] = $process;
        }
        $deadline = microtime(true) + 20;
        while (!is_file($directory.'/ready-0') || !is_file($directory.'/ready-1')) {
            requireProbe(microtime(true) < $deadline, 'Ready barrier timeout.');
            usleep(10000);
        }
        file_put_contents($directory.'/start', 'start');
        foreach ($processes as $process) requireProbe(proc_close($process) === 0, 'A competing publisher failed.');
        $processes = [];
        $results = [json_decode(file_get_contents($directory.'/result-0'), true, 512, JSON_THROW_ON_ERROR), json_decode(file_get_contents($directory.'/result-1'), true, 512, JSON_THROW_ON_ERROR)];
        $outcomes = array_column($results, 'outcome');
        sort($outcomes);
        $expectedOutcomes = [$expected, 'skipped'];
        sort($expectedOutcomes);
        requireProbe($outcomes === $expectedOutcomes, 'Wrong outcomes: '.$name);
        requireProbe(count(file($directory.'/requests')) === 1, 'More than one transport call: '.$name);
        requireProbe(min(array_column($results, 'elapsed')) >= 0.35, 'Publishers did not overlap long enough: '.$name);
        $row = DB::table('outbox_events')->where('id', $id)->first();
        requireProbe((int) $row->attempts === ($success ? $attempts : $attempts + 1), 'Wrong failure count: '.$name);
        requireProbe(($row->published_at !== null) === $success, 'Wrong publication state: '.$name);
        echo "$name: two competing processes, one transport call, state preserved.\n";
    }
    echo "Three MySQL concurrency scenarios passed. Audit transport was simulated; no outage was introduced.\n";
} finally {
    foreach ($processes as $process) {
        if (is_resource($process)) { proc_terminate($process); proc_close($process); }
    }
    if ($ids) DB::table('outbox_events')->whereIn('id', $ids)->where('action', 'outbox.integration_probe')->delete();
    foreach ($directories as $directory) {
        foreach (glob($directory.'/*') as $file) if (is_file($file)) unlink($file);
        rmdir($directory);
    }
}
