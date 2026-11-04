// wrangler의 Text 규칙으로 .html 파일을 문자열로 import 할 수 있게 하는 타입 선언
declare module "*.html" {
  const content: string;
  export default content;
}
