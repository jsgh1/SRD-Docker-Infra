<?php
require '/app/services/records/vendor/autoload.php';
$app = require '/app/services/records/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Support\Carbon;
use App\Application\PersonFields;
use App\Application\PersonService;
if (!app()->environment('local') || config('database.default') !== 'mysql' || getenv('SRD_ALLOW_FIELD_PROBE') !== '1') throw new RuntimeException('Explicit local MySQL probe required.');
function checkFieldProbe(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function waitFieldProbe(string $file): void {
    $deadline = microtime(true) + 20;
    while (!is_file($file)) { checkFieldProbe(microtime(true) < $deadline, 'Barrier timeout.'); usleep(10000); }
}
if (($argv[1] ?? '') === 'worker') {
    [$script, $worker, $directory, $org, $index, $scenario] = $argv;
    checkFieldProbe(Str::isUuid($org) && in_array($index, ['0', '1'], true) && in_array($scenario, ['schema-schema', 'schema-existing', 'schema-person'], true), 'Invalid probe input.');
    checkFieldProbe(realpath($directory) === realpath(storage_path('framework')).'/field-probe-'.$org, 'Invalid probe directory.');
    Carbon::setTestNow(now()->addDays(2)); // Keep synthetic outbox events away from the live scheduler.
    $p = ['organization_id' => $org, 'user_id' => $org, 'role' => 'admin'];
    file_put_contents($directory.'/ready-'.$index, 'ready');
    waitFieldProbe($directory.'/start');
    if ($scenario === 'schema-person' && $index === '1') waitFieldProbe($directory.'/locked');
    $start = microtime(true);
    try {
        DB::transaction(function () use ($directory, $scenario, $index, $p) {
            if ($scenario === 'schema-person' && $index === '1') {
                app(PersonService::class)->save($p, ['document_type' => 'CC', 'document_number' => 'SYNTHETIC', 'first_names' => 'Concurrency probe', 'status' => 'pending', 'schema_version' => 0, 'authorization_basis' => 'Synthetic probe', 'authorization_purpose' => 'Local concurrency verification']);
            } else {
                app(PersonFields::class)->configure($p, ['version' => 0, 'fields' => []]);
                if ($scenario === 'schema-person') file_put_contents($directory.'/locked', 'locked');
                usleep(800000);
            }
        });
        $outcome = 'saved';
    } catch (Symfony\Component\HttpKernel\Exception\HttpException $e) {
        if ($e->getStatusCode() !== 409) throw $e;
        $outcome = 'conflict';
    }
    file_put_contents($directory.'/result-'.$index, json_encode(['outcome' => $outcome, 'elapsed' => microtime(true) - $start], JSON_THROW_ON_ERROR));
    exit(0);
}
$orgs = []; $directories = []; $processes = [];
try {
    foreach (['schema-schema', 'schema-existing', 'schema-person'] as $scenario) {
        $org = (string) Str::uuid(); $orgs[] = $org;
        if ($scenario === 'schema-existing') DB::table('person_field_schemas')->insert(['organization_id' => $org, 'version' => 0, 'fields' => '[]', 'created_at' => now(), 'updated_at' => now()]);
        $directory = storage_path('framework/field-probe-'.$org);
        checkFieldProbe(mkdir($directory, 0700), 'Cannot create probe directory.'); $directories[] = $directory;
        foreach ([0, 1] as $index) {
            $process = proc_open([PHP_BINARY, __FILE__, 'worker', $directory, $org, (string) $index, $scenario], [0 => ['file', '/dev/null', 'r'], 1 => ['file', $directory.'/stdout-'.$index, 'w'], 2 => ['file', $directory.'/stderr-'.$index, 'w']], $pipes);
            checkFieldProbe(is_resource($process), 'Cannot launch probe worker.'); $processes[] = $process;
        }
        waitFieldProbe($directory.'/ready-0'); waitFieldProbe($directory.'/ready-1'); file_put_contents($directory.'/start', 'start');
        foreach ($processes as $process) checkFieldProbe(proc_close($process) === 0, 'Probe worker failed.'); $processes = [];
        $results = array_map(fn ($i) => json_decode(file_get_contents($directory.'/result-'.$i), true, 512, JSON_THROW_ON_ERROR), [0, 1]);
        $outcomes = array_column($results, 'outcome'); sort($outcomes);
        checkFieldProbe($outcomes === ['conflict', 'saved'], 'Expected one saved configuration and one conflict.');
        checkFieldProbe(min(array_column($results, 'elapsed')) >= .35, 'Workers did not overlap long enough.');
        checkFieldProbe((int) DB::table('person_field_schemas')->where('organization_id', $org)->value('version') === 1, 'Incorrect schema version.');
        checkFieldProbe(DB::table('persons')->where('organization_id', $org)->count() === 0, 'A stale form created a person.');
        checkFieldProbe(DB::table('outbox_events')->where('organization_id', $org)->count() === 1, 'Incorrect committed audit count.');
        echo "$scenario: concurrent MySQL transactions passed; one save, one conflict.\n";
    }
} finally {
    foreach ($processes as $process) if (is_resource($process)) { proc_terminate($process); proc_close($process); }
    if ($orgs) {
        DB::table('persons')->whereIn('organization_id', $orgs)->delete();
        DB::table('outbox_events')->whereIn('organization_id', $orgs)->delete();
        DB::table('person_field_schemas')->whereIn('organization_id', $orgs)->delete();
    }
    foreach ($directories as $directory) { foreach (glob($directory.'/*') as $file) if (is_file($file)) unlink($file); rmdir($directory); }
}
