<?php

declare(strict_types=1);

require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$recipient = config('mail.mailers.smtp.username');
if (!is_string($recipient) || !filter_var($recipient, FILTER_VALIDATE_EMAIL)) {
    throw new RuntimeException('SMTP recipient missing');
}

Illuminate\Support\Facades\Mail::raw(
    'Prueba de entrega de SRD. Si recibes este correo, la configuración SMTP funciona.',
    static function ($message) use ($recipient): void {
        $message->to($recipient)->subject('Prueba SMTP de SRD');
    }
);

echo "SMTP_SEND_OK\n";
