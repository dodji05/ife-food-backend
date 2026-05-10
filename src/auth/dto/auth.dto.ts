import { IsString, IsNotEmpty, Length, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendOtpDto {
  @ApiProperty({ example: '+22991234567' }) @IsString() @IsNotEmpty() phone: string;
  @ApiProperty({ example: 'BJ' }) @IsString() @IsNotEmpty() countryCode: string;
}

export class VerifyOtpDto {
  @ApiProperty() @IsString() @IsNotEmpty() phone: string;
  @ApiProperty() @IsString() @Length(6, 6) code: string;
  @ApiProperty() @IsString() @IsNotEmpty() sessionId: string;
  @ApiPropertyOptional({ enum: ['CLIENT', 'PROFESSIONAL', 'DRIVER'] })
  @IsOptional() @IsIn(['CLIENT', 'PROFESSIONAL', 'DRIVER']) role?: string;
}

export class SetPinDto {
  @ApiProperty() @IsString() @Length(4, 6) pin: string;
}

export class VerifyPinDto {
  @ApiProperty() @IsString() @IsNotEmpty() phone: string;
  @ApiProperty() @IsString() @Length(4, 6) pin: string;
}

export class Verify2faDto {
  @ApiProperty() @IsString() @Length(6, 6) code: string;
}
