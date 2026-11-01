<?php
// Verifies only the deterministic, synthetic mobile account in an isolated local database.
$root=getenv('SRD_ROOT') ?: dirname(__DIR__);
$fixturePath=getenv('SRD_FIXTURE_PATH') ?: "$root/.local/e2e-fixture.json";
require "$root/services/identity/vendor/autoload.php";
$app=require "$root/services/identity/bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if(!app()->environment('local') || getenv('SRD_ALLOW_MYSQL_FIXTURES')!=='1'){
    throw new RuntimeException('Mobile fixture verification requires the isolated local QA environment.');
}
$fixture=json_decode(file_get_contents($fixturePath),true,512,JSON_THROW_ON_ERROR);
$mobile=$fixture['mobile_user']??null;
if(!is_array($mobile) || empty($mobile['id']) || empty($mobile['email']) || empty($fixture['password']) || empty($fixture['orgA'])){
    throw new RuntimeException('mobile-fixture-incomplete');
}
$user=Illuminate\Support\Facades\DB::table('users')->where('id',$mobile['id'])->where('email',$mobile['email'])->first();
if(!$user || !$user->active || !Illuminate\Support\Facades\Hash::check($fixture['password'],$user->password)){
    throw new RuntimeException('mobile-fixture-account-not-authenticatable');
}
$memberships=Illuminate\Support\Facades\DB::table('memberships')->where('user_id',$mobile['id'])->where('active',true)->get();
if($memberships->count()!==1 || $memberships[0]->organization_id!==$fixture['orgA'] || $memberships[0]->role!=='viewer'){
    throw new RuntimeException('mobile-fixture-viewer-membership-invalid');
}
$registrar=$fixture['mobile_registrar_user']??null;
if(!is_array($registrar) || empty($registrar['id']) || empty($registrar['email'])){
    throw new RuntimeException('mobile-registrar-fixture-incomplete');
}
$registrarUser=Illuminate\Support\Facades\DB::table('users')->where('id',$registrar['id'])->where('email',$registrar['email'])->first();
if(!$registrarUser || !$registrarUser->active || $registrarUser->superadmin || !Illuminate\Support\Facades\Hash::check($fixture['password'],$registrarUser->password)){
    throw new RuntimeException('mobile-registrar-fixture-account-not-authenticatable');
}
$registrarMemberships=Illuminate\Support\Facades\DB::table('memberships')->where('user_id',$registrar['id'])->where('active',true)->get();
if($registrarMemberships->count()!==1 || $registrarMemberships[0]->organization_id!==$fixture['orgA'] || $registrarMemberships[0]->role!=='registrar'){
    throw new RuntimeException('mobile-registrar-fixture-membership-invalid');
}
echo "PASS synthetic Android registrar fixture is active and ready; no credentials printed.\n";
echo "PASS synthetic Android login fixture is active and ready; no credentials printed.\n";
