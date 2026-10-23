<?php
// Synthetic local fixtures only. No input document or ZIP data is used.
$root=getenv('SRD_ROOT') ?: dirname(__DIR__);$service=$argv[1]??'';
if(!in_array($service,['identity','configuration','calendar','audit'],true))exit(1);
require "$root/services/$service/vendor/autoload.php";
$app=require "$root/services/$service/bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if(!app()->environment('local') || (config('database.default')!=='sqlite' && getenv('SRD_ALLOW_MYSQL_FIXTURES')!=='1'))throw new RuntimeException('Fixtures require an explicitly selected isolated local environment.');
$file=getenv('SRD_FIXTURE_PATH') ?: "$root/.local/e2e-fixture.json";
if(is_file($file))$fixture=json_decode(file_get_contents($file),true);
else {
 $fixture=['password'=>bin2hex(random_bytes(18)),'orgA'=>'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','orgB'=>'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','termsA'=>'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','termsB'=>'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','users'=>[]];
 foreach(['admin','registrar','treasurer','auditor','viewer','superadmin'] as $role)$fixture['users'][$role]=['id'=>(string)Illuminate\Support\Str::uuid(),'email'=>"$role@srd-e2e.test"];
 file_put_contents($file,json_encode($fixture,JSON_PRETTY_PRINT));
}
Illuminate\Support\Facades\DB::transaction(function()use($service,$fixture){
 if($service==='configuration')foreach(['A','B']as $letter){
  $id=$fixture['org'.$letter];
  Illuminate\Support\Facades\DB::table('organizations')->insertOrIgnore(['id'=>$id,'code'=>$fixture['code'.$letter] ?? 'srd-e2e-'.strtolower($letter),'name'=>'Junta de prueba '. $letter,'created_at'=>now(),'updated_at'=>now()]);
  Illuminate\Support\Facades\DB::table('terms_versions')->insertOrIgnore(['id'=>$fixture['terms'.$letter],'organization_id'=>$id,'version'=>1,'body'=>'Términos ficticios de desarrollo. Este entorno solo contiene cuentas y personas sintéticas para verificar SRD. No introducir información real.','published_at'=>now()]);
 }elseif($service==='identity')foreach($fixture['users']as $role=>$user){
  Illuminate\Support\Facades\DB::table('users')->insertOrIgnore(['id'=>$user['id'],'email'=>$user['email'],'name'=>'Prueba '.ucfirst($role),'password'=>Illuminate\Support\Facades\Hash::make($fixture['password']),'superadmin'=>$role==='superadmin','created_at'=>now(),'updated_at'=>now()]);
  Illuminate\Support\Facades\DB::table('memberships')->insertOrIgnore(['id'=>(string)Illuminate\Support\Str::uuid(),'user_id'=>$user['id'],'organization_id'=>$fixture['orgA'],'role'=>$role]);
  if($role==='viewer' && in_array(getenv('SRD_BROWSER_SPEC'),['chat-switch-organization.spec.mjs','platform-accounts.spec.mjs','profile-photo.spec.mjs'],true))
   Illuminate\Support\Facades\DB::table('memberships')->insertOrIgnore(['id'=>(string)Illuminate\Support\Str::uuid(),'user_id'=>$user['id'],'organization_id'=>$fixture['orgB'],'role'=>'viewer']);
 }
 if($service==='identity' && getenv('SRD_BROWSER_SPEC')==='chat-conversations-pagination.spec.mjs'){
  $password=Illuminate\Support\Facades\Hash::make($fixture['password']);
  foreach($fixture['extra_chat_users']??[] as $user){
   Illuminate\Support\Facades\DB::table('users')->insertOrIgnore(['id'=>$user['id'],'email'=>$user['email'],'name'=>$user['name'],'password'=>$password,'created_at'=>now(),'updated_at'=>now()]);
   Illuminate\Support\Facades\DB::table('memberships')->insertOrIgnore(['id'=>(string)Illuminate\Support\Str::uuid(),'user_id'=>$user['id'],'organization_id'=>$fixture['orgA'],'role'=>'viewer']);
  }
 }
 if($service==='identity' && getenv('SRD_BROWSER_SPEC')==='audit-retry.spec.mjs'){
  Illuminate\Support\Facades\DB::table('outbox_events')->insertOrIgnore([
   'id'=>$fixture['retry_event_id'],'organization_id'=>$fixture['orgA'],
   'actor_id'=>$fixture['users']['admin']['id'],'action'=>'test.retry_exhausted',
   'resource_id'=>null,'result'=>'success','correlation_id'=>(string)Illuminate\Support\Str::uuid(),
   'occurred_at'=>now()->subMinute(),'attempts'=>4,'next_attempt_at'=>now()->subMinute(),
  ]);
 }
 if($service==='identity' && getenv('SRD_BROWSER_SPEC')==='mail-delivery-retry.spec.mjs'){
  $actor=$fixture['users']['admin']['id'];$organization=$fixture['orgA'];
  $secret=bin2hex(random_bytes(32));
  Illuminate\Support\Facades\DB::table('invitations')->insertOrIgnore([
   'id'=>$fixture['mail_retry_invitation_id'],'organization_id'=>$organization,'invited_by'=>$actor,
   'email'=>$fixture['mail_retry_invitation_email'],'role'=>'viewer',
   'secret_hash'=>hash('sha256',$secret),'secret_encrypted'=>Illuminate\Support\Facades\Crypt::encryptString($secret),
   'expires_at'=>now()->addDay(),'delivery_attempts'=>4,'next_attempt_at'=>now()->subMinute(),'created_at'=>now(),
  ]);
  Illuminate\Support\Facades\DB::table('security_notices')->insertOrIgnore([
   'id'=>$fixture['mail_retry_notice_id'],'organization_id'=>$organization,'user_id'=>$actor,
   'destination_encrypted'=>Illuminate\Support\Facades\Crypt::encryptString($fixture['mail_retry_notice_email']),
   'kind'=>'email_changed','attempts'=>4,'next_attempt_at'=>now()->subMinute(),'created_at'=>now(),
  ]);
 }
 if($service==='calendar' && getenv('SRD_BROWSER_SPEC')==='calendar-delivery-retry.spec.mjs'){
  $organization=$fixture['orgA'];$event=$fixture['calendar_retry_event_id'];$job=$fixture['calendar_retry_job_id'];$actor=$fixture['users']['admin']['id'];
  Illuminate\Support\Facades\DB::table('calendar_events')->insertOrIgnore([
   'id'=>$event,'organization_id'=>$organization,'type'=>'meeting','title'=>'Aviso sintético de prueba',
   'starts_at'=>now()->addDay(),'ends_at'=>now()->addDay()->addHour(),
   'created_by'=>$actor,'updated_by'=>$actor,'created_at'=>now(),'updated_at'=>now(),
  ]);
  Illuminate\Support\Facades\DB::table('calendar_participants')->insertOrIgnore([
   'event_id'=>$event,'organization_id'=>$organization,'user_id'=>$actor,'name'=>'Prueba Admin',
   'created_at'=>now(),'updated_at'=>now(),
  ]);
  Illuminate\Support\Facades\DB::table('calendar_delivery_jobs')->insertOrIgnore([
   'id'=>$job,'organization_id'=>$organization,'user_id'=>$actor,'event_id'=>$event,
   'kind'=>'event_changed','title'=>'Aviso sintético de prueba','delivery_key'=>hash('sha256',$job),
   'due_at'=>now()->subMinutes(2),'next_attempt_at'=>now()->subMinute(),'attempts'=>8,
   'created_at'=>now(),'updated_at'=>now(),
  ]);
 }
 if($service==='audit' && getenv('SRD_BROWSER_SPEC')==='audit-export.spec.mjs'){
  Illuminate\Support\Facades\DB::table('audit_events')->insertOrIgnore([
   'id'=>(string)Illuminate\Support\Str::uuid(), 'organization_id'=>$fixture['orgA'],
   'actor_id'=>$fixture['users']['admin']['id'], 'service'=>'identity',
   'action'=>'test.audit_export', 'resource_id'=>null, 'result'=>'success',
   'correlation_id'=>(string)Illuminate\Support\Str::uuid(), 'occurred_at'=>now(), 'event_version'=>1,
  ]);
 }
});
echo "Synthetic fixtures ready: $service. Credentials remain in the selected local fixture.\n";
