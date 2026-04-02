{{/*
Expand the name of the chart.
*/}}
{{- define "trialo-core.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "trialo-core.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "trialo-core.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "trialo-core.labels" -}}
helm.sh/chart: {{ include "trialo-core.chart" . }}
{{ include "trialo-core.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: trialo
{{- end }}

{{/*
Selector labels
*/}}
{{- define "trialo-core.selectorLabels" -}}
app.kubernetes.io/name: {{ include "trialo-core.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service-specific selector labels — accepts a dict with "root" (.) and "svcName"
*/}}
{{- define "trialo-core.serviceSelectorLabels" -}}
app.kubernetes.io/name: {{ .svcName }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: trialo
{{- end }}

{{/*
Service-specific common labels — accepts a dict with "root" (.) and "svcName"
*/}}
{{- define "trialo-core.serviceLabels" -}}
helm.sh/chart: {{ include "trialo-core.chart" .root }}
app.kubernetes.io/name: {{ .svcName }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- if .root.Chart.AppVersion }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: trialo
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "trialo-core.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "trialo-core.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Return the global image registry prefix (with trailing slash if set)
*/}}
{{- define "trialo-core.imageRegistry" -}}
{{- if .Values.global.imageRegistry -}}
{{- printf "%s/" .Values.global.imageRegistry -}}
{{- end -}}
{{- end }}

{{/*
Return imagePullSecrets list
*/}}
{{- define "trialo-core.imagePullSecrets" -}}
{{- if .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range .Values.global.imagePullSecrets }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}
