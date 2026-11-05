<?php
require '/app/services/records/vendor/autoload.php';
$app = require '/app/services/records/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Support\Carbon;
use App\Application\PersonPositions;
use App\Application\PersonService;

if (!app()->environment('local') || config('database.default') !== 'mysql' || getenv('SRD_ALLOW_POSITION_PROBE') !== '1') throw new RuntimeException('Explicit local MySQL probe required.');
function checkPositionProbe(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function waitPositionProbe(string $file): void {
    $deadline = microtime(true) + 30;
    while (!is_file($file)) { checkPositionProbe(microtime(true) < $deadline, 'Barrier timeout.'); usleep(10000); }
}
function personPositionProbe(): array {
    return ['document_type'=>'CC','document_number'=>'SYNTHETIC-POSITION','first_names'=>'Concurrency probe','status'=>'pending','schema_version'=>0,'positions_version'=>0,'position_code'=>'president','authorization_basis'=>'Synthetic probe','authorization_purpose'=>'Local concurrency verification'];
}
const POSITION_SCENARIOS = ['catalog-new','catalog-existing','stale-create','stale-update','person-first'];
Carbon::setTestNow(now()->addDays(2)); // Synthetic outbox events must not reach the live scheduler.
if (($argv[1] ?? '') === 'worker') {
    [$script, $worker, $directory, $org, $index, $scenario, $personId] = $argv;
    checkPositionProbe(Str::isUuid($org) && in_array($index, ['0','1'], true) && in_array($scenario, POSITION_SCENARIOS, true), 'Invalid probe input.');
    checkPositionProbe(realpath($directory) === realpath(storage_path('framework')).'/position-probe-'.$org, 'Invalid probe directory.');
    checkPositionProbe($personId === '-' || Str::isUuid($personId), 'Invalid person identifier.');
    DB::statement('SET SESSION innodb_lock_wait_timeout = 15');
    $p = ['organization_id'=>$org,'user_id'=>$org,'role'=>'admin'];
    file_put_contents($directory.'/ready-'.$index, 'ready');
    waitPositionProbe($directory.'/start');
    if ($index === '1') waitPositionProbe($directory.'/locked');
    $start = microtime(true);
    if ($index === '1') file_put_contents($directory.'/contending', 'ready');
    try {
        DB::transaction(function () use ($directory, $scenario, $index, $p, $personId) {
            $personWrite = ($index === '1' && in_array($scenario, ['stale-create','stale-update'], true)) || ($index === '0' && $scenario === 'person-first');
            if ($personWrite) {
                $data = personPositionProbe();
                if ($scenario === 'stale-update') { $data['version'] = 1; $data['first_names'] = 'Must not overwrite'; }
                app(PersonService::class)->save($p, $data, $personId === '-' ? null : $personId);
            } else {
                $items = app(PersonPositions::class)->defaults();
                $items[0]['label'] = 'Renamed by worker '.$index;
                $items[0]['active'] = false;
                app(PersonPositions::class)->configure($p, ['version'=>0,'items'=>$items]);
            }
            if ($index === '0') {
                file_put_contents($directory.'/locked', 'locked');
                waitPositionProbe($directory.'/contending');
                usleep(800000);
            }
        });
        $outcome = 'saved';
    } catch (Symfony\Component\HttpKernel\Exception\HttpException $e) {
        if ($e->getStatusCode() !== 409) throw $e;
        $outcome = 'conflict';
    }
    file_put_contents($directory.'/result-'.$index, json_encode(['outcome'=>$outcome,'elapsed'=>microtime(true)-$start], JSON_THROW_ON_ERROR));
    exit(0);
}
$orgs = []; $directories = []; $processes = []; $report = [];
try {
    foreach (POSITION_SCENARIOS as $scenario) {
        $org = (string) Str::uuid(); $orgs[] = $org;
        $p = ['organization_id'=>$org,'user_id'=>$org,'role'=>'admin'];
        $personId = '-';
        if ($scenario === 'catalog-existing') DB::table('person_position_catalogs')->insert(['organization_id'=>$org,'version'=>0,'items'=>json_encode(app(PersonPositions::class)->defaults()),'created_at'=>now(),'updated_at'=>now()]);
        if ($scenario === 'stale-update') $personId = app(PersonService::class)->save($p, personPositionProbe())['data']['id'];
        $beforeEvents = DB::table('outbox_events')->where('organization_id',$org)->count();
        $directory = storage_path('framework/position-probe-'.$org);
        checkPositionProbe(mkdir($directory,0700),'Cannot create probe directory.'); $directories[] = $directory;
        foreach ([0,1] as $index) {
            $process = proc_open([PHP_BINARY,__FILE__,'worker',$directory,$org,(string)$index,$scenario,$personId], [0=>['file','/dev/null','r'],1=>['file',$directory.'/stdout-'.$index,'w'],2=>['file',$directory.'/stderr-'.$index,'w']], $pipes);
            checkPositionProbe(is_resource($process),'Cannot launch worker.'); $processes[] = $process;
        }
        waitPositionProbe($directory.'/ready-0'); waitPositionProbe($directory.'/ready-1'); file_put_contents($directory.'/start','start');
        foreach ($processes as $process) checkPositionProbe(proc_close($process) === 0,'Worker failed; inspect probe errors.'); $processes = [];
        $results = array_map(fn($i)=>json_decode(file_get_contents($directory.'/result-'.$i),true,512,JSON_THROW_ON_ERROR),[0,1]);
        $expected = $scenario === 'person-first' ? ['saved','saved'] : ['saved','conflict'];
        checkPositionProbe(array_column($results,'outcome') === $expected,'Unexpected outcomes: '.$scenario);
        checkPositionProbe($results[1]['elapsed'] >= .35,'No sustained transaction overlap.');
        $catalog = app(PersonPositions::class)->catalog($org);
        checkPositionProbe($catalog['version'] === 1 && $catalog['items'][0]['active'] === false,'Invalid committed catalog.');
        checkPositionProbe($catalog['items'][0]['label'] === 'Renamed by worker '.($scenario === 'person-first' ? '1' : '0'),'Catalog overwritten.');
        $hasPerson = in_array($scenario,['stale-update','person-first'],true);
        checkPositionProbe(DB::table('persons')->where('organization_id',$org)->count() === ($hasPerson ? 1 : 0),'Incorrect person count.');
        if ($hasPerson) {
            $person = DB::table('persons')->where('organization_id',$org)->first();
            checkPositionProbe((int)$person->version === 1 && $person->first_names === 'Concurrency probe' && $person->position_label === 'Presidente','Historical person was overwritten.');
            checkPositionProbe(DB::table('data_authorizations')->where('organization_id',$org)->count() === 1,'Incorrect authorization count.');
        } else {
            foreach (['data_authorizations','person_field_values','person_field_schemas'] as $table) checkPositionProbe(DB::table($table)->where('organization_id',$org)->count() === 0,'Stale transaction left partial rows.');
        }
        $events = DB::table('outbox_events')->where('organization_id',$org)->count()-$beforeEvents;
        checkPositionProbe($events === ($scenario === 'person-first' ? 2 : 1),'Incorrect committed audit count.');
        $report[] = ['scenario'=>$scenario,'results'=>$results,'catalog_version'=>1,'new_events'=>$events];
        echo "$scenario: passed; ".implode(', ',$expected)."; history and audit verified.\n";
    }
} finally {
    foreach ($processes as $process) if (is_resource($process)) { proc_terminate($process); proc_close($process); }
    if ($orgs) {
        foreach (['persons','outbox_events','person_field_schemas','person_position_catalogs'] as $table) DB::table($table)->whereIn('organization_id',$orgs)->delete();
        foreach (['persons','outbox_events','person_field_schemas','person_position_catalogs','data_authorizations','person_field_values'] as $table) checkPositionProbe(DB::table($table)->whereIn('organization_id',$orgs)->count() === 0,'Probe cleanup incomplete.');
    }
    foreach ($directories as $directory) {
        foreach (glob($directory.'/*') as $file) if (is_file($file)) unlink($file);
        rmdir($directory);
    }
}
echo json_encode(['passed'=>count($report),'cleanup'=>'verified','scenarios'=>$report],JSON_THROW_ON_ERROR|JSON_PRETTY_PRINT)."\n";
