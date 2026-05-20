import { IsEmail, IsString, MinLength, Length } from 'class-validator';

export class AdminLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

export class AdminRequestResetDto {
  @IsEmail()
  email: string;
}

export class AdminConfirmResetDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  code: string;

  @IsString()
  sessionId: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
